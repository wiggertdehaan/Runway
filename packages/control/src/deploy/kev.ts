import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Finding } from "./scan.js";

/**
 * CISA Known Exploited Vulnerabilities catalog. Trivy's JSON does not
 * flag KEV membership, so we fetch the public CISA feed (fixed URL, no
 * user input) and match on CVE id. The list is cached on disk next to
 * the DB for 24h; if CISA is unreachable we fall back to a stale copy
 * rather than silently treating "no data" as "no exploited CVEs".
 *
 * www.cisa.gov sits behind a CDN that answers 403 to some hosting
 * provider address ranges, so a server can be locked out of the feed
 * through no fault of its own. CISA publishes the same file in its own
 * GitHub repository; that copy is tried when the primary URL fails.
 */

export const KEV_URL =
  "https://www.cisa.gov/sites/default/files/feeds/known_exploited_vulnerabilities.json";
export const KEV_MIRROR_URL =
  "https://raw.githubusercontent.com/cisagov/kev-data/develop/known_exploited_vulnerabilities.json";
/** Tried in order; the first source that yields a non-empty list wins. */
export const KEV_SOURCES: readonly string[] = [KEV_URL, KEV_MIRROR_URL];
const DB_PATH = process.env.DB_PATH || join(process.cwd(), "runway.db");
const CACHE_PATH = process.env.KEV_CACHE_PATH || join(dirname(DB_PATH), "kev.json");
const TTL_MS = 24 * 60 * 60 * 1000;

export interface KevList {
  ids: Set<string>;
  /** ISO time the list was fetched, null if never available. */
  fetchedAt: string | null;
  /** True when the list could not be refreshed and may be old/empty. */
  stale: boolean;
}

/** Pure: extract CVE ids from the CISA feed JSON. */
export function parseKevFeed(raw: unknown): Set<string> {
  const ids = new Set<string>();
  const list = (raw as { vulnerabilities?: Array<{ cveID?: unknown }> })
    ?.vulnerabilities;
  if (!Array.isArray(list)) return ids;
  for (const v of list) {
    if (typeof v?.cveID === "string") ids.add(v.cveID.toUpperCase());
  }
  return ids;
}

/** Pure: findings whose CVE is on the KEV list (deduped by id). */
export function kevFindings(findings: Finding[], kev: Set<string>): Finding[] {
  const seen = new Set<string>();
  const out: Finding[] = [];
  for (const f of findings) {
    const id = f.id.toUpperCase();
    if (f.source !== "image" || !kev.has(id) || seen.has(id)) continue;
    seen.add(id);
    out.push(f);
  }
  return out;
}

interface CacheFile {
  fetchedAt: string;
  ids: string[];
}

function readCache(): CacheFile | null {
  try {
    if (!existsSync(CACHE_PATH)) return null;
    const parsed = JSON.parse(readFileSync(CACHE_PATH, "utf8")) as CacheFile;
    if (!Array.isArray(parsed.ids) || typeof parsed.fetchedAt !== "string") return null;
    return parsed;
  } catch {
    return null;
  }
}

/**
 * What the cached list holds, read from disk only. For views that render
 * often: unlike getKevList this never goes to the network.
 */
export function kevCacheInfo(): { fetchedAt: string; count: number } | null {
  const cached = readCache();
  return cached ? { fetchedAt: cached.fetchedAt, count: cached.ids.length } : null;
}

function writeCache(c: CacheFile): void {
  try {
    mkdirSync(dirname(CACHE_PATH), { recursive: true });
    const tmp = `${CACHE_PATH}.tmp`;
    writeFileSync(tmp, JSON.stringify(c));
    renameSync(tmp, CACHE_PATH);
  } catch {
    /* cache is an optimisation only */
  }
}

type Logger = Pick<Console, "log" | "warn">;

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

async function fetchFeed(url: string, fetchFn: typeof fetch): Promise<Set<string>> {
  const res = await fetchFn(url, { signal: AbortSignal.timeout(20_000) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const ids = parseKevFeed(await res.json());
  if (ids.size === 0) throw new Error("feed contained no CVEs");
  return ids;
}

/**
 * Callers poll this every minute; without a usable cache every call
 * refetches. Repeat the same failure only once so a long outage is one
 * log line, not 1440 a day.
 */
let lastFailureLogged: string | null = null;

/**
 * After a round in which every source failed, skip the network for a
 * while. Two time-outs cost ~40 s, and the app page asks for the list on
 * each request. Reset on success; tests can pass `now` to step past it.
 */
export const KEV_RETRY_BACKOFF_MS = 5 * 60 * 1000;
let retryNotBefore = 0;

export async function getKevList(
  fetchFn: typeof fetch = fetch,
  log: Logger = console
): Promise<KevList> {
  const cached = readCache();
  if (cached && Date.now() - Date.parse(cached.fetchedAt) < TTL_MS) {
    return { ids: new Set(cached.ids), fetchedAt: cached.fetchedAt, stale: false };
  }
  const staleResult = (): KevList =>
    cached
      ? { ids: new Set(cached.ids), fetchedAt: cached.fetchedAt, stale: true }
      : { ids: new Set(), fetchedAt: null, stale: true };
  if (Date.now() < retryNotBefore) return staleResult();
  const failures: string[] = [];
  for (const url of KEV_SOURCES) {
    try {
      const ids = await fetchFeed(url, fetchFn);
      const fetchedAt = new Date().toISOString();
      writeCache({ fetchedAt, ids: [...ids] });
      const from = `[kev] list refreshed from ${hostOf(url)} (${ids.size} CVEs)`;
      if (failures.length > 0) log.warn(`${from}; failed first: ${failures.join("; ")}`);
      else log.log(from);
      lastFailureLogged = null;
      retryNotBefore = 0;
      return { ids, fetchedAt, stale: false };
    } catch (err: any) {
      failures.push(`${hostOf(url)}: ${err?.message ?? err}`);
    }
  }
  retryNotBefore = Date.now() + KEV_RETRY_BACKOFF_MS;
  const summary = failures.join("; ");
  if (summary !== lastFailureLogged) {
    lastFailureLogged = summary;
    log.warn(
      `[kev] list could not be refreshed (${summary}); ${
        cached ? `using the copy from ${cached.fetchedAt}` : "no cached copy, KEV checks are off"
      }`
    );
  }
  return staleResult();
}
