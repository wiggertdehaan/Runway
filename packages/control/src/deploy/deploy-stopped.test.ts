/**
 * Decision: a deploy to an app somebody stopped is allowed. The new version is
 * built, scanned and recorded, but nothing is started and the app stays
 * stopped until Start, which then runs the NEW version.
 */
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const calls = vi.hoisted(() => [] as string[]);
vi.mock("./docker.js", async (orig) => {
  const real = await orig<typeof import("./docker.js")>();
  return {
    ...real,
    buildImageFromTar: vi.fn(async () => ({ log: "built" })),
    runContainer: vi.fn(async (o: { imageTag: string }) => {
      calls.push(`create:${o.imageTag}`);
      return { containerId: "c1" };
    }),
    removeImageByTag: vi.fn(async () => true),
    removeContainerByName: vi.fn(async () => void calls.push("remove")),
    stopContainerByName: vi.fn(async () => {}),
    containerImageTag: vi.fn(async () => null),
    startContainerByName: vi.fn(async () => {}),
  };
});
vi.mock("./scan.js", async (orig) => {
  const real = await orig<typeof import("./scan.js")>();
  return { ...real, trivyAvailable: () => false };
});
vi.mock("./source.js", () => ({ saveSource: vi.fn(), pruneOldSources: vi.fn(), deleteAllSources: vi.fn() }));
vi.mock("./gateway.js", async (orig) => {
  const real = await orig<typeof import("./gateway.js")>();
  return { ...real, writeAppRoute: vi.fn(async () => void calls.push("route:app")), writeMaintenanceRoute: vi.fn(async () => {}) };
});
vi.mock("./health.js", () => ({ waitForHealthy: vi.fn(async () => ({ healthy: true, reason: "ok" })), judgeHealth: vi.fn() }));

import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { db, migrate } from "../db/index.js";
import { createApp, getApp, updateApp } from "../db/apps.js";
import { deployApp } from "./index.js";
import { startApp } from "./lifecycle.js";

const work = mkdtempSync(join(tmpdir(), "runway-stopdeploy-"));
beforeAll(() => migrate());
beforeEach(() => {
  db.exec("DELETE FROM apps");
  calls.length = 0;
});
function tar(): Buffer {
  const dir = join(work, `s${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir);
  writeFileSync(join(dir, "Dockerfile"), "FROM node");
  const out = `${dir}.tar`;
  execFileSync("tar", ["-cf", out, "-C", dir, "./Dockerfile"]);
  return readFileSync(out);
}

describe("deploy to a stopped app", () => {
  it("records the new version, starts nothing, writes no app route, stays stopped", async () => {
    const a0 = createApp();
    const a = updateApp(a0.id, { name: "S", runtime: "node", port: 3000, domain: "s.example.com", image_tag: "old:v1", status: "stopped", stopped_at: new Date().toISOString() } as never)!;
    const r = await deployApp({ app: a, tar: tar() });
    expect(r.stopped).toBe(true);
    expect(calls.filter((c) => c.startsWith("create:"))).toEqual([]);
    expect(calls).not.toContain("route:app");
    const after = getApp(a.id)!;
    expect(after.status).toBe("stopped");
    expect(after.image_tag).toBe(r.image_tag);
    expect(after.image_tag).not.toBe("old:v1");
    expect(after.stopped_at).toBeTruthy();
  });
  it("Start afterwards runs the NEW version", async () => {
    const a0 = createApp();
    const a = updateApp(a0.id, { name: "S", runtime: "node", port: 3000, domain: "s.example.com", image_tag: "old:v1", status: "stopped", stopped_at: new Date().toISOString() } as never)!;
    const r = await deployApp({ app: a, tar: tar() });
    calls.length = 0;
    expect(await startApp(a.id)).toMatchObject({ ok: true, changed: true });
    expect(calls).toContain(`create:${r.image_tag}`);
    expect(getApp(a.id)!.status).toBe("running");
  });
  it("a normal (running) app deploys and runs as before", async () => {
    const a0 = createApp();
    const a = updateApp(a0.id, { name: "R", runtime: "node", port: 3000, domain: "r.example.com", image_tag: "old:v1", status: "running" } as never)!;
    const r = await deployApp({ app: a, tar: tar() });
    expect(r.stopped).toBeUndefined();
    expect(calls.some((c) => c.startsWith("create:"))).toBe(true);
    expect(getApp(a.id)!.status).toBe("running");
  });
});
