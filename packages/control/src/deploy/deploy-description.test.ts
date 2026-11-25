/**
 * deployApp fills an empty description from the README and never overwrites
 * one that is there. Docker, the scanner and the gateway are replaced; the
 * database, the tar handling and the description code are real.
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("./docker.js", async (orig) => {
  const real = await orig<typeof import("./docker.js")>();
  return {
    ...real,
    buildImageFromTar: vi.fn(async () => ({ log: "built" })),
    runContainer: vi.fn(async () => ({ containerId: "c1" })),
    removeImageByTag: vi.fn(async () => {}),
    removeContainerByName: vi.fn(async () => {}),
    stopContainerByName: vi.fn(async () => {}),
  };
});
vi.mock("./scan.js", async (orig) => {
  const real = await orig<typeof import("./scan.js")>();
  return { ...real, trivyAvailable: () => false };
});
vi.mock("./source.js", () => ({ saveSource: vi.fn(), pruneOldSources: vi.fn(), deleteAllSources: vi.fn() }));

import { migrate } from "../db/index.js";
import { createApp, getApp, updateApp } from "../db/apps.js";
import { deployApp } from "./index.js";

const work = mkdtempSync(join(tmpdir(), "runway-deploydesc-"));
afterAll(() => rmSync(work, { recursive: true, force: true }));
beforeAll(() => migrate());

let n = 0;
function tarWith(files: Record<string, string>): Buffer {
  const dir = join(work, `s${n++}`);
  mkdirSync(dir);
  for (const [k, v] of Object.entries(files)) writeFileSync(join(dir, k), v);
  const out = join(work, `t${n}.tar`);
  execFileSync("tar", ["-cf", out, "-C", dir, ...Object.keys(files).map((f) => `./${f}`)]);
  return readFileSync(out);
}
function freshApp() {
  const a = createApp();
  return updateApp(a.id, { name: "X", runtime: "node", port: 3000 } as never)!;
}
const README = "# Rosa Cockpit\n\nDashboard for the field team to follow open jobs per region.\n";

describe("deploy and the description", () => {
  it("fills an empty description from the README", async () => {
    const a = freshApp();
    await deployApp({ app: a, tar: tarWith({ Dockerfile: "FROM node", "README.md": README }) });
    expect(getApp(a.id)!.description).toBe("Dashboard for the field team to follow open jobs per region.");
  });
  it("never overwrites a hand-written description", async () => {
    const a = freshApp();
    updateApp(a.id, { description: "Written by hand" });
    await deployApp({ app: getApp(a.id)!, tar: tarWith({ Dockerfile: "FROM node", "README.md": README }) });
    expect(getApp(a.id)!.description).toBe("Written by hand");
  });
  it("not even when the stale app object in the deploy still says empty (set meanwhile)", async () => {
    const a = freshApp();
    const stale = getApp(a.id)!;
    updateApp(a.id, { description: "Set during the build" });
    await deployApp({ app: stale, tar: tarWith({ Dockerfile: "FROM node", "README.md": README }) });
    expect(getApp(a.id)!.description).toBe("Set during the build");
  });
  it("a second deploy with a changed README keeps what the first one filled in", async () => {
    const a = freshApp();
    await deployApp({ app: a, tar: tarWith({ Dockerfile: "FROM node", "README.md": README }) });
    await deployApp({ app: getApp(a.id)!, tar: tarWith({ Dockerfile: "FROM node", "README.md": "# New\n\nSomething else entirely.\n" }) });
    expect(getApp(a.id)!.description).toBe("Dashboard for the field team to follow open jobs per region.");
  });
  it("a cleared description is filled again by the next deploy (empty means empty)", async () => {
    const a = freshApp();
    await deployApp({ app: a, tar: tarWith({ Dockerfile: "FROM node", "README.md": README }) });
    updateApp(a.id, { description: null });
    await deployApp({ app: getApp(a.id)!, tar: tarWith({ Dockerfile: "FROM node", "README.md": "# N\n\nBack again.\n" }) });
    expect(getApp(a.id)!.description).toBe("Back again.");
  });
  it("no README leaves it empty and the deploy succeeds", async () => {
    const a = freshApp();
    const r = await deployApp({ app: a, tar: tarWith({ Dockerfile: "FROM node" }) });
    expect(r.container_id).toBe("c1");
    expect(getApp(a.id)!.description).toBeNull();
  });
  it("a README without a paragraph leaves it empty", async () => {
    const a = freshApp();
    await deployApp({ app: a, tar: tarWith({ Dockerfile: "FROM node", "README.md": "# Only a title\n" }) });
    expect(getApp(a.id)!.description).toBeNull();
  });
  it("a dry run (no deploy happens) does not touch it", async () => {
    const a = freshApp();
    await deployApp({ app: a, tar: tarWith({ Dockerfile: "FROM node", "README.md": README }), dryRun: true });
    expect(getApp(a.id)!.description).toBeNull();
  });
});
