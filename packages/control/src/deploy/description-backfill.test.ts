import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const sources = vi.hoisted(() => new Map<string, string>());
vi.mock("./source.js", async (orig) => {
  const real = await orig<typeof import("./source.js")>();
  return { ...real, latestSource: (id: string) => (sources.has(id) ? { path: sources.get(id)!, deployId: 1, bytes: 1, mtime: new Date() } : null) };
});

import { db, migrate } from "../db/index.js";
import { createApp, getApp, updateApp } from "../db/apps.js";
import { deleteSetting, getSetting } from "../db/settings.js";
import { runDescriptionBackfill, runDescriptionBackfillOnce } from "./description-backfill.js";

const work = mkdtempSync(join(tmpdir(), "runway-backfill-"));
afterAll(() => rmSync(work, { recursive: true, force: true }));
beforeAll(() => migrate());

let n = 0;
function tarFile(files: Record<string, string>): string {
  const dir = join(work, `s${n++}`);
  mkdirSync(dir);
  for (const [k, v] of Object.entries(files)) writeFileSync(join(dir, k), v);
  const out = join(work, `t${n}.tar`);
  execFileSync("tar", ["-cf", out, "-C", dir, ...Object.keys(files).map((f) => `./${f}`)]);
  return out;
}

beforeEach(() => {
  db.exec("DELETE FROM apps");
  deleteSetting("description_backfill_v1");
  sources.clear();
});

const mk = () => createApp();

describe("description backfill (real database, real tars)", () => {
  it("fills empty descriptions from the stored source README", async () => {
    const a = mk();
    sources.set(a.id, tarFile({ Dockerfile: "FROM x", "README.md": "# A\n\nDoes a thing for the team.\n" }));
    await runDescriptionBackfillOnce();
    expect(getApp(a.id)!.description).toBe("Does a thing for the team.");
  });
  it("leaves a hand-written description alone", async () => {
    const a = mk();
    updateApp(a.id, { description: "By hand" });
    sources.set(a.id, tarFile({ "README.md": "# A\n\nFrom the README.\n" }));
    await runDescriptionBackfillOnce();
    expect(getApp(a.id)!.description).toBe("By hand");
  });
  it("runs only once: a later start does nothing, even for a new empty app", async () => {
    const a = mk();
    sources.set(a.id, tarFile({ "README.md": "# A\n\nFirst.\n" }));
    await runDescriptionBackfillOnce();
    expect(getSetting("description_backfill_v1")).toBeTruthy();
    updateApp(a.id, { description: null });
    await runDescriptionBackfillOnce();
    expect(getApp(a.id)!.description).toBeNull();
  });
  it("a broken tar, no README and no source do not stop the others, and the pass still completes", async () => {
    const broken = mk();
    const none = mk();
    const nosrc = mk();
    const good = mk();
    const garbage = join(work, "garbage.tar");
    writeFileSync(garbage, "not a tar at all");
    sources.set(broken.id, garbage);
    sources.set(none.id, tarFile({ Dockerfile: "FROM x" }));
    sources.set(good.id, tarFile({ "README.md": "# G\n\nGood one.\n" }));
    const logs: string[] = [];
    await runDescriptionBackfillOnce({ log: (m) => logs.push(m) });
    expect(getApp(good.id)!.description).toBe("Good one.");
    for (const a of [broken, none, nosrc]) expect(getApp(a.id)!.description).toBeNull();
    expect(logs.join("\n")).toContain(`${none.id}: no README paragraph`);
    expect(logs.join("\n")).toContain(`${nosrc.id}: no stored source`);
    expect(logs.join("\n")).toContain(`${good.id}: filled`);
    expect(logs.at(-1)).toMatch(/done: 1 filled, 2 no README, 1 no source, 0 kept, 0 failed/);
    expect(getSetting("description_backfill_v1")).toBeTruthy();
  });
});

describe("description backfill (injected failures)", () => {
  const base = () => {
    let marked = false;
    const logs: string[] = [];
    return {
      logs,
      marked: () => marked,
      deps: {
        listApps: () => [{ id: "a", description: null }, { id: "b", description: null }],
        latestSource: () => ({ path: "/x" }),
        readFile: () => Buffer.from(""),
        describe: () => "text",
        setIfEmpty: vi.fn(() => true),
        done: () => false,
        markDone: () => void (marked = true),
        yieldTurn: async () => {},
        log: (m: string) => void logs.push(m),
      },
    };
  };
  it("an exception for one app is logged and the next still runs", async () => {
    const t = base();
    let first = true;
    t.deps.readFile = () => {
      if (first) {
        first = false;
        throw new Error("disk gone");
      }
      return Buffer.from("");
    };
    const r = await runDescriptionBackfill(t.deps);
    expect(r).toMatchObject({ filled: 1, failed: 1 });
    expect(t.logs.join("\n")).toContain("a: failed (disk gone)");
    expect(t.marked()).toBe(true);
  });
  it("if the list itself blows up it never throws and does not mark done (retried next start)", async () => {
    const t = base();
    t.deps.listApps = () => {
      throw new Error("db locked");
    };
    await expect(runDescriptionBackfill(t.deps)).resolves.toBeTruthy();
    expect(t.marked()).toBe(false);
    expect(t.logs.join("\n")).toContain("aborted: db locked");
  });
  it("returns null without touching anything when the marker is set", async () => {
    const t = base();
    t.deps.done = () => true;
    expect(await runDescriptionBackfill(t.deps)).toBeNull();
    expect(t.deps.setIfEmpty).not.toHaveBeenCalled();
  });
  it("yields between apps so the server stays responsive", async () => {
    const t = base();
    const y = vi.fn(async () => {});
    t.deps.yieldTurn = y;
    await runDescriptionBackfill(t.deps);
    expect(y).toHaveBeenCalledTimes(2);
  });
});
