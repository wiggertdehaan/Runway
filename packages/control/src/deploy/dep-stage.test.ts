import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DepStageContext } from "./dep-stage.js";
import type { DepUpdate } from "./dep-updates.js";
import type { DeployInput } from "./index.js";
import type { Finding, ScanResult } from "./scan.js";

// In-memory DB: the stage writes owner notices and remembers attempts.
process.env.DB_PATH = ":memory:";

type Mods = {
  runDepStage: typeof import("./dep-stage.js").runDepStage;
  ScanBlockedError: typeof import("./index.js").ScanBlockedError;
  UnhealthyDeployError: typeof import("./index.js").UnhealthyDeployError;
  createApp: typeof import("../db/apps.js").createApp;
  updateApp: typeof import("../db/apps.js").updateApp;
  getApp: typeof import("../db/apps.js").getApp;
  listNotices: typeof import("../db/quarantine.js").listNotices;
  recentDepFailures: typeof import("../db/dep-attempts.js").recentDepFailures;
  recordDepAttempt: typeof import("../db/dep-attempts.js").recordDepAttempt;
};
let m: Mods;
const work = mkdtempSync(join(tmpdir(), "runway-stagetest-"));
let tar: Buffer;

beforeAll(async () => {
  const { migrate } = await import("../db/index.js");
  migrate();
  m = {
    ...(await import("./dep-stage.js")),
    ...(await import("./index.js")),
    ...(await import("../db/apps.js")),
    ...(await import("../db/quarantine.js")),
    ...(await import("../db/dep-attempts.js")),
  } as unknown as Mods;
  writeFileSync(join(work, "requirements.txt"), "Pillow>=12.2,<13.0\n");
  execFileSync("tar", ["-cf", join(work, "src.tar"), "-C", work, "./requirements.txt"]);
  tar = readFileSync(join(work, "src.tar"));
});
afterAll(() => rmSync(work, { recursive: true, force: true }));

const f = (id: string, severity: Finding["severity"] = "CRITICAL"): Finding => ({
  id, severity, source: "image", pkg: "pillow", version: "12.3.0", fixedVersion: "13.0.0", pkgType: "python-pkg",
});
const scanOf = (findings: Finding[]): ScanResult => ({
  status: findings.length ? "warned" : "passed", findings,
  counts: { critical: 0, high: 0, medium: 0, low: 0, unknown: 0 },
});
const pillow: DepUpdate = {
  ecosystem: "python", name: "pillow", from: "12.3.0", to: "13.0.0", kind: "major", cves: ["CVE-P"],
};

function ctx(over: Partial<DepStageContext> = {}): DepStageContext {
  const app = m.createApp();
  m.updateApp(app.id, { name: "demo", status: "running", image_tag: "img:old" });
  return {
    app: m.getApp(app.id)!,
    tar,
    dockerfile: null,
    updates: [pillow],
    strict: true,
    baseline: [f("CVE-P")],
    kev: new Set(),
    plan: undefined,
    quarantined: false,
    previousStatus: "running",
    originalDeployId: 41,
    log: { log() {}, warn() {}, error() {} },
    lockSync: async () => { throw new Error("no lockfile expected"); },
    isServing: async () => true,
    ...over,
  };
}

/** A deploy that runs the scan gate against `scan`, like deployApp does. */
function fakeDeploy(scan: ScanResult, seen: DeployInput[] = []): DepStageContext["deploy"] {
  return (async (input: DeployInput) => {
    seen.push(input);
    const verdict = input.scanGate!(scan);
    if (!verdict.allow) throw new m.ScanBlockedError(scan, "img:new", 1, verdict.reason);
    return {
      app_id: input.app.id, image_tag: "img:new", container_id: "c", container_name: "n",
      domain: null, log_tail: "", scan, base_images: [],
    };
  }) as DepStageContext["deploy"];
}

describe("runDepStage", () => {
  it("goes live with the patched source and tells the owner", async () => {
    const seen: DeployInput[] = [];
    const c = ctx({ deploy: fakeDeploy(scanOf([]), seen) });
    const out = await m.runDepStage(c);

    expect(out.steps).toEqual([
      { ecosystem: "python", pkg: "pillow", from: "12.3.0", to: "13.0.0", kind: "major", outcome: "applied", detail: undefined },
    ]);
    expect(out.result?.image_tag).toBe("img:new");
    expect(out.halted).toBe(false);
    // The patched tar is what was built, and it is saved as the new snapshot.
    expect(seen[0].skipSourceSave).toBe(false);
    expect(seen[0].noCache).toBe(true);
    expect(seen[0].verifyHealth).toBe(true);
    expect(seen[0].tar).toBe(out.tar);
    expect(out.tar).not.toBe(tar);

    const notice = m.listNotices(c.app.id)[0];
    expect(notice.kind).toBe("deps_updated");
    expect(notice.message).toContain("pillow 12.3.0 → 13.0.0 (major)");
    expect(notice.message).toContain("deploy #41");
    expect(notice.message).toContain("requirements.txt");
    expect(m.recentDepFailures(c.app.id).size).toBe(0);
  });

  it("stays on the running version when the finding is still there", async () => {
    const c = ctx({ deploy: fakeDeploy(scanOf([f("CVE-P")])) });
    m.updateApp(c.app.id, { status: "scanning" }); // what deployApp leaves behind
    const out = await m.runDepStage(c);

    expect(out.result).toBeUndefined();
    expect(out.steps[0].outcome).toBe("blocked");
    expect(out.steps[0].detail).toContain("did not remove CVE-P");
    expect(m.getApp(c.app.id)!.status).toBe("running");
    expect(m.listNotices(c.app.id)).toEqual([]);
    expect([...m.recentDepFailures(c.app.id)]).toEqual(["python:pillow@13.0.0"]);
  });

  it("refuses a build that is worse than what runs now", async () => {
    const c = ctx({ deploy: fakeDeploy(scanOf([f("CVE-NEW")])) });
    const out = await m.runDepStage(c);
    expect(out.steps[0].outcome).toBe("blocked");
    expect(out.steps[0].detail).toContain("worse than the running version");
  });

  it("halts further updates when the new container does not start", async () => {
    const c = ctx({
      deploy: (async () => {
        throw new m.UnhealthyDeployError("exited", "img:new", true, scanOf([]));
      }) as DepStageContext["deploy"],
    });
    const out = await m.runDepStage(c);
    expect(out.halted).toBe(true);
    expect(out.steps[0].outcome).toBe("unhealthy");
    expect([...m.recentDepFailures(c.app.id)]).toEqual(["python:pillow@13.0.0"]);
  });

  it("reports a failed build with the last log line and restores the status", async () => {
    const c = ctx({
      previousStatus: "running",
      deploy: (async () => {
        throw Object.assign(new Error("Build failed (exit 1)"), { log: "step 1\nERROR: No matching distribution found for pillow>=13.0.0\n" });
      }) as DepStageContext["deploy"],
    });
    m.updateApp(c.app.id, { status: "building" });
    const out = await m.runDepStage(c);
    expect(out.steps[0].outcome).toBe("failed");
    expect(out.steps[0].detail).toContain("No matching distribution");
    expect(m.getApp(c.app.id)!.status).toBe("running");
  });

  it("keeps a quarantined app quarantined when the attempt is blocked", async () => {
    const c = ctx({ quarantined: true, previousStatus: "quarantined", deploy: fakeDeploy(scanOf([f("CVE-P")])) });
    await m.runDepStage(c);
    expect(m.getApp(c.app.id)!.status).toBe("quarantined");
  });

  it("does not build at all when nothing could be applied", async () => {
    let called = false;
    const c = ctx({
      updates: [{ ...pillow, ecosystem: "node", name: "qs" }],
      deploy: (async () => { called = true; throw new Error("no"); }) as DepStageContext["deploy"],
    });
    const out = await m.runDepStage(c);
    expect(called).toBe(false);
    expect(out.steps[0].outcome).toBe("skipped");
    expect(out.steps[0].detail).toContain("no package.json");
  });

  it("a later success clears the remembered failure", async () => {
    const c = ctx();
    m.recordDepAttempt(c.app.id, "python:pillow@13.0.0", "failed", "x");
    expect(m.recentDepFailures(c.app.id).size).toBe(1);
    m.recordDepAttempt(c.app.id, "python:pillow@13.0.0", "applied");
    expect(m.recentDepFailures(c.app.id).size).toBe(0);
  });
});

describe("runDepStage when the new container could not be started", () => {
  const boom = (async () => {
    throw new Error("no such image");
  }) as DepStageContext["deploy"];

  it("brings the previous image back instead of reporting 'running'", async () => {
    const restored: string[] = [];
    const c = ctx({
      deploy: boom,
      isServing: async () => false,
      restore: (async (app: { id: string; image_tag: string | null }) => {
        restored.push(app.image_tag!);
        m.updateApp(app.id, { status: "running" });
      }) as DepStageContext["restore"],
    });
    m.updateApp(c.app.id, { status: "starting" });
    const out = await m.runDepStage(c);
    expect(restored).toEqual(["img:old"]);
    expect(out.halted).toBe(true);
    expect(out.steps[0].outcome).toBe("failed");
    expect(m.getApp(c.app.id)!.status).toBe("running");
  });

  it("marks the app failed when it is down and cannot be restored", async () => {
    const c = ctx({
      deploy: boom,
      isServing: async () => false,
      restore: (async () => { throw new Error("docker down"); }) as DepStageContext["restore"],
    });
    const out = await m.runDepStage(c);
    expect(out.halted).toBe(true);
    expect(m.getApp(c.app.id)!.status).toBe("failed");
  });

  it("remembers an update it could not place, so it is not retried weekly", async () => {
    const c = ctx({ updates: [{ ...pillow, ecosystem: "node", name: "qs", to: "6.16.1" }] });
    await m.runDepStage(c);
    expect([...m.recentDepFailures(c.app.id)]).toEqual(["node:qs@6.16.1"]);
  });
});
