import { describe, it, expect, beforeEach, afterEach, afterAll, vi } from "vitest";
import { mkdirSync, rmSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { dirname } from "node:path";

// kev.ts fixes its cache path at module load; point it away from any real
// kev.json before the import below is evaluated.
const CACHE = vi.hoisted(() => {
  const path = `${process.env.TMPDIR ?? "/tmp"}/runway-kev-test-${process.pid}/kev.json`;
  process.env.KEV_CACHE_PATH = path;
  return path;
});

import { parseKevFeed, kevFindings, getKevList, KEV_URL, KEV_MIRROR_URL, KEV_RETRY_BACKOFF_MS } from "./kev.js";
import type { Finding } from "./scan.js";

const f = (id: string, source: Finding["source"] = "image"): Finding => ({ id, severity: "HIGH", source });

describe("parseKevFeed", () => {
  it("extracts upper-cased CVE ids", () => {
    const ids = parseKevFeed({ vulnerabilities: [{ cveID: "cve-2024-1" }, { cveID: "CVE-2024-2" }, {}] });
    expect([...ids].sort()).toEqual(["CVE-2024-1", "CVE-2024-2"]);
  });
  it("tolerates garbage", () => {
    expect(parseKevFeed(null).size).toBe(0);
    expect(parseKevFeed({ vulnerabilities: "x" }).size).toBe(0);
  });
});

describe("kevFindings", () => {
  const kev = new Set(["CVE-2024-1"]);
  it("keeps only listed CVEs, deduped, image findings only", () => {
    const out = kevFindings([f("CVE-2024-1"), f("CVE-2024-1"), f("CVE-2024-9"), f("CVE-2024-1", "secret")], kev);
    expect(out.map((x) => x.id)).toEqual(["CVE-2024-1"]);
  });
});

describe("getKevList", () => {
  const feed = (...ids: string[]) =>
    new Response(JSON.stringify({ vulnerabilities: ids.map((cveID) => ({ cveID })) }), { status: 200 });
  const denied = () => new Response("<H1>Access Denied</H1>", { status: 403 });
  const quiet = () => ({ log: vi.fn(), warn: vi.fn() });
  /** Answer per URL; records which URLs were asked, in order. */
  const fetcher = (answers: Record<string, () => Response>) => {
    const asked: string[] = [];
    const fn = (async (url: string) => {
      asked.push(url);
      const answer = answers[url];
      if (!answer) throw new Error("fetch failed");
      return answer();
    }) as unknown as typeof fetch;
    return { fn, asked };
  };
  const writeOldCache = (ids: string[]) => {
    mkdirSync(dirname(CACHE), { recursive: true });
    const fetchedAt = new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString();
    writeFileSync(CACHE, JSON.stringify({ fetchedAt, ids }));
    return fetchedAt;
  };

  // The retry backoff is module state; every test starts a fresh "day" past it.
  let clock = Date.now();
  beforeEach(() => {
    rmSync(CACHE, { force: true });
    clock += 10 * KEV_RETRY_BACKOFF_MS;
    vi.useFakeTimers({ toFake: ["Date"], now: clock });
  });
  afterEach(() => vi.useRealTimers());
  afterAll(() => rmSync(dirname(CACHE), { recursive: true, force: true }));

  it("uses the primary feed and does not touch the mirror when it works", async () => {
    const { fn, asked } = fetcher({ [KEV_URL]: () => feed("CVE-2024-1") });
    const log = quiet();
    const list = await getKevList(fn, log);
    expect([...list.ids]).toEqual(["CVE-2024-1"]);
    expect(list.stale).toBe(false);
    expect(asked).toEqual([KEV_URL]);
    expect(log.warn).not.toHaveBeenCalled();
  });

  it("falls back to the mirror when the primary feed answers 403", async () => {
    const { fn, asked } = fetcher({ [KEV_URL]: denied, [KEV_MIRROR_URL]: () => feed("CVE-2024-1", "cve-2024-2") });
    const log = quiet();
    const list = await getKevList(fn, log);
    expect([...list.ids].sort()).toEqual(["CVE-2024-1", "CVE-2024-2"]);
    expect(list.stale).toBe(false);
    expect(list.fetchedAt).not.toBeNull();
    expect(asked).toEqual([KEV_URL, KEV_MIRROR_URL]);
    expect(log.warn).toHaveBeenCalledTimes(1);
    expect(log.warn.mock.calls[0][0]).toContain("raw.githubusercontent.com");
    expect(log.warn.mock.calls[0][0]).toContain("www.cisa.gov: HTTP 403");
    // The fresh list is cached, so the next call needs no network at all.
    expect(JSON.parse(readFileSync(CACHE, "utf8")).ids.sort()).toEqual(["CVE-2024-1", "CVE-2024-2"]);
    const again = fetcher({});
    expect((await getKevList(again.fn, quiet())).ids.size).toBe(2);
    expect(again.asked).toEqual([]);
  });

  it("treats an empty primary feed as a failure and tries the mirror", async () => {
    const { fn, asked } = fetcher({ [KEV_URL]: () => feed(), [KEV_MIRROR_URL]: () => feed("CVE-2024-1") });
    const list = await getKevList(fn, quiet());
    expect([...list.ids]).toEqual(["CVE-2024-1"]);
    expect(asked).toEqual([KEV_URL, KEV_MIRROR_URL]);
  });

  it("returns the stale cache when every source fails", async () => {
    const fetchedAt = writeOldCache(["CVE-2023-9"]);
    const { fn } = fetcher({ [KEV_URL]: denied, [KEV_MIRROR_URL]: denied });
    const list = await getKevList(fn, quiet());
    expect([...list.ids]).toEqual(["CVE-2023-9"]);
    expect(list.fetchedAt).toBe(fetchedAt);
    expect(list.stale).toBe(true);
  });

  it("returns an empty, never-fetched list when every source fails and there is no cache", async () => {
    const { fn } = fetcher({});
    const list = await getKevList(fn, quiet());
    expect(list.ids.size).toBe(0);
    expect(list.fetchedAt).toBeNull();
    expect(list.stale).toBe(true);
    expect(existsSync(CACHE)).toBe(false);
  });

  it("reports an unchanged failure once, not on every poll", async () => {
    const { fn } = fetcher({ [KEV_URL]: () => new Response("", { status: 503 }), [KEV_MIRROR_URL]: denied });
    const log = quiet();
    await getKevList(fn, log);
    await getKevList(fn, log);
    await getKevList(fn, log);
    expect(log.warn).toHaveBeenCalledTimes(1);
    expect(log.warn.mock.calls[0][0]).toContain("www.cisa.gov: HTTP 503");
    expect(log.warn.mock.calls[0][0]).toContain("raw.githubusercontent.com: HTTP 403");
  });

  it("skips the network for a while after every source failed, then retries", async () => {
    const dead = fetcher({ [KEV_URL]: denied, [KEV_MIRROR_URL]: denied });
    const log = quiet();
    await getKevList(dead.fn, log);
    expect(dead.asked).toEqual([KEV_URL, KEV_MIRROR_URL]);
    // Within the backoff: no requests, still the stale/empty answer.
    vi.setSystemTime(clock + KEV_RETRY_BACKOFF_MS - 1000);
    const during = await getKevList(dead.fn, log);
    expect(during.stale).toBe(true);
    expect(dead.asked).toHaveLength(2);
    // After it: tries again, and a working source recovers the list.
    vi.setSystemTime(clock + KEV_RETRY_BACKOFF_MS + 1000);
    const live = fetcher({ [KEV_URL]: () => feed("CVE-2024-1") });
    const after = await getKevList(live.fn, log);
    expect(after.stale).toBe(false);
    expect(live.asked).toEqual([KEV_URL]);
  });
});
