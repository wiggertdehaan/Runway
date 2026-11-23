import { describe, it, expect, beforeAll } from "vitest";
import type { EscalationContext } from "./escalation.js";
import type { Finding, ScanResult } from "./scan.js";
import type { TagSource } from "./base-images.js";

// In-memory DB: escalation writes owner notices.
process.env.DB_PATH = ":memory:";

type Mods = {
  escalateBase: typeof import("./escalation.js").escalateBase;
  ScanBlockedError: typeof import("./index.js").ScanBlockedError;
  UnhealthyDeployError: typeof import("./index.js").UnhealthyDeployError;
  createApp: typeof import("../db/apps.js").createApp;
  updateApp: typeof import("../db/apps.js").updateApp;
  getApp: typeof import("../db/apps.js").getApp;
  listNotices: typeof import("../db/quarantine.js").listNotices;
};
let m: Mods;

beforeAll(async () => {
  const { migrate } = await import("../db/index.js");
  migrate();
  m = {
    ...(await import("./escalation.js")),
    ...(await import("./index.js")),
    ...(await import("../db/apps.js")),
    ...(await import("../db/quarantine.js")),
  } as unknown as Mods;
});

const f = (id: string, severity: Finding["severity"] = "HIGH", fixedVersion?: string): Finding => ({
  id, severity, source: "image", fixedVersion,
});
const scanOf = (findings: Finding[]): ScanResult => ({
  status: "warned", findings, counts: { critical: 0, high: 0, medium: 0, low: 0, unknown: 0 },
});
const kev = new Set(["CVE-KEV"]);

/** Fake registry: tags per repo, keyed by the requested prefix filter. */
function tags(map: Record<string, string[]>): TagSource {
  return async (ref, opts) => {
    const all = map[ref.repo] ?? [];
    return opts?.filter ? all.filter((t) => t.startsWith(opts.filter!)) : all;
  };
}

const NGINX = ["1.29.8-alpine", "1.30.6-alpine", "1.30.7-alpine", "1.31.8-alpine", "1.31.9-alpine", "2.0.1-alpine", "2.1.0-alpine"];

/**
 * Fake deployApp driven by a "what does tag X scan like" table. It runs the
 * real scanGate the way the real deployApp does, so the gate is exercised.
 */
function fakeDeploy(scans: Record<string, Finding[]>, opts: { unhealthy?: string[]; calls?: string[] } = {}) {
  return (async (input: any) => {
    const df: string | undefined = input.basePlan?.dockerfile;
    const tag = /FROM nginx:(\S+)/.exec(df ?? "")?.[1] ?? "?";
    opts.calls?.push(`${input.dryRun ? "dry:" : ""}${tag}`);
    const scan = scanOf(scans[tag] ?? []);
    if (input.dryRun) return { scan, base_images: [] };
    const v = input.scanGate(scan);
    if (!v.allow) throw new m.ScanBlockedError(scan, `img:${tag}`, 1, v.reason);
    if (opts.unhealthy?.includes(tag)) throw new m.UnhealthyDeployError("healthcheck failing", `img:${tag}`, true, scan);
    return { scan, base_images: [{ image: `docker.io/library/nginx:${tag}`, digest: "sha256:" + "a".repeat(64), auto_minor_from: "1.29" }] };
  }) as unknown as NonNullable<EscalationContext["deploy"]>;
}

function ctx(over: Partial<EscalationContext> & { dockerfile?: string; live?: Finding[] } = {}): EscalationContext {
  const app = m.createApp("tester");
  m.updateApp(app.id, { name: "esc-app", image_tag: "img:live", status: "running" });
  return {
    app: { ...app, name: "esc-app", image_tag: "img:live", status: "running" },
    tar: Buffer.from(""),
    dockerfile: over.dockerfile ?? "FROM nginx:1.29.8-alpine\nCOPY . /x\n",
    plan: undefined,
    liveFindings: over.live ?? [f("CVE-KEV"), f("CVE-C1", "CRITICAL", "2"), f("CVE-H")],
    kev,
    tagSource: tags({ "library/nginx": NGINX }),
    log: { log() {}, warn() {}, error() {} },
    ...over,
  };
}

describe("escalateBase", () => {
  it("does nothing when no KEV / critical-with-fix is left", async () => {
    const calls: string[] = [];
    const out = await m.escalateBase(ctx({ live: [f("CVE-H"), f("CVE-M", "MEDIUM")], deploy: fakeDeploy({}, { calls }) }));
    expect(out.steps).toEqual([]);
    expect(calls).toEqual([]);
  });

  it("picks the LOWEST newer minor that resolves everything (1.29 -> 1.30, not 1.31)", async () => {
    const calls: string[] = [];
    const c = ctx({ deploy: fakeDeploy({ "1.30.7-alpine": [f("CVE-H")], "1.31.9-alpine": [] }, { calls }) });
    const out = await m.escalateBase(c);
    expect(calls).toEqual(["1.30.7-alpine"]);
    expect(out.steps).toHaveLength(1);
    expect(out.steps[0]).toMatchObject({ kind: "minor", outcome: "applied", from: "nginx:1.29.8-alpine", to: "nginx:1.30.7-alpine" });
    expect(out.steps[0].detail).toContain("auto-minor 1.29→1.30");
    expect(out.plan?.patches.some((p) => p.kind === "minor" && p.to === "nginx:1.30.7-alpine")).toBe(true);
    expect(out.result).toBeDefined();
    const notices = m.listNotices(c.app.id);
    expect(notices[0].kind).toBe("auto_minor");
    expect(notices[0].message).toContain("1.29→1.30");
  });

  it("a minor that only fixes some targets is blocked, the next one is tried", async () => {
    const calls: string[] = [];
    const out = await m.escalateBase(
      ctx({ deploy: fakeDeploy({ "1.30.7-alpine": [f("CVE-KEV")], "1.31.9-alpine": [] }, { calls }) })
    );
    expect(calls).toEqual(["1.30.7-alpine", "1.31.9-alpine"]);
    expect(out.steps.map((s) => s.outcome)).toEqual(["blocked", "applied"]);
    expect(out.steps[0].detail).toContain("minor 1.30 still has CVE-KEV");
  });

  it("a minor that is WORSE than what runs is blocked by the normal gate", async () => {
    const out = await m.escalateBase(
      ctx({ deploy: fakeDeploy({ "1.30.7-alpine": [f("CVE-NEWCRIT", "CRITICAL", "1")], "1.31.9-alpine": [f("CVE-NEWCRIT", "CRITICAL", "1")] }) })
    );
    expect(out.steps.map((s) => s.outcome).slice(0, 2)).toEqual(["blocked", "blocked"]);
    expect(out.steps[0].detail).toContain("worse than the running version");
    expect(out.result).toBeUndefined();
  });

  it("an unhealthy minor stops escalation and leaves the previous version running", async () => {
    const calls: string[] = [];
    const out = await m.escalateBase(ctx({ deploy: fakeDeploy({ "1.30.7-alpine": [] }, { unhealthy: ["1.30.7-alpine"], calls }) }));
    expect(calls).toEqual(["1.30.7-alpine"]);
    expect(out.steps[0]).toMatchObject({ outcome: "unhealthy" });
    expect(out.steps[0].detail).toContain("stayed on nginx:1.29.8-alpine");
    expect(out.result).toBeUndefined();
  });

  it("tries at most three minor lines, lowest first, then gives up", async () => {
    const calls: string[] = [];
    const many = ["1.29.8-alpine", "1.30.7-alpine", "1.31.9-alpine", "1.32.1-alpine", "1.33.0-alpine"];
    const stillBad = { "1.30.7-alpine": [f("CVE-KEV")], "1.31.9-alpine": [f("CVE-KEV")], "1.32.1-alpine": [f("CVE-KEV")], "1.33.0-alpine": [f("CVE-KEV")] };
    const out = await m.escalateBase(
      ctx({ tagSource: tags({ "library/nginx": many }), deploy: fakeDeploy(stillBad, { calls }), live: [f("CVE-KEV")] })
    );
    expect(calls).toEqual(["1.30.7-alpine", "1.31.9-alpine", "1.32.1-alpine"]);
    expect(out.steps.map((s) => s.outcome)).toEqual(["blocked", "blocked", "blocked"]);
    expect(out.result).toBeUndefined();
  });

  it("NEVER applies a major: only probes it (dry run) and reports 'major X resolves Y'", async () => {
    const calls: string[] = [];
    const only129 = ["1.29.8-alpine", "2.0.1-alpine", "2.1.0-alpine", "3.0.0-alpine"]; // no newer minor
    const c = ctx({
      tagSource: tags({ "library/nginx": only129 }),
      deploy: fakeDeploy({ "2.1.0-alpine": [f("CVE-H")] }, { calls }),
    });
    const out = await m.escalateBase(c);
    expect(calls).toEqual(["dry:2.1.0-alpine"]); // probe only, lowest newer major, never a real deploy
    expect(out.result).toBeUndefined();
    expect(out.steps).toHaveLength(1);
    expect(out.steps[0]).toMatchObject({ kind: "major", outcome: "notice" });
    expect(out.steps[0].detail).toMatch(/^major 2\.1 \(nginx:2\.1\.0-alpine\) resolves CVE-KEV, CVE-C1/);
    expect(out.steps[0].detail).toContain("never automatic");
    expect(m.listNotices(c.app.id)[0].kind).toBe("major_available");
  });

  it("does not repeat the identical major notice within a week", async () => {
    const mk = () =>
      ctx({ tagSource: tags({ "library/nginx": ["1.29.8-alpine", "2.0.1-alpine"] }), deploy: fakeDeploy({ "2.0.1-alpine": [] }) });
    const c = mk();
    await m.escalateBase(c);
    await m.escalateBase({ ...mk(), app: c.app });
    expect(m.listNotices(c.app.id).filter((n) => n.kind === "major_available")).toHaveLength(1);
  });

  it("a major that does not help either is reported quietly (no owner notice)", async () => {
    const c = ctx({
      tagSource: tags({ "library/nginx": ["1.29.8-alpine", "2.0.1-alpine"] }),
      deploy: fakeDeploy({ "2.0.1-alpine": [f("CVE-KEV"), f("CVE-C1", "CRITICAL", "2")] }),
    });
    const out = await m.escalateBase(c);
    expect(out.steps[0].detail).toContain("does not resolve them either");
    expect(m.listNotices(c.app.id)).toHaveLength(0);
  });

  it("minor-pinned runtime base follows the minor tag style", async () => {
    const calls: string[] = [];
    const out = await m.escalateBase(
      ctx({
        dockerfile: "FROM nginx:1.29-alpine\n",
        tagSource: tags({ "library/nginx": ["1.29-alpine", "1.30-alpine", "1.31-alpine"] }),
        deploy: fakeDeploy({ "1.30-alpine": [] }, { calls }),
      })
    );
    expect(calls).toEqual(["1.30-alpine"]);
    expect(out.steps[0].to).toBe("nginx:1.30-alpine");
  });

  it("only the RUNTIME stage is escalated in a multi-stage build", async () => {
    const calls: string[] = [];
    const out = await m.escalateBase(
      ctx({
        dockerfile: "FROM nginx:1.29.8-alpine AS build\nRUN x\nFROM scratch\nCOPY --from=build /a /a\n",
        deploy: fakeDeploy({}, { calls }),
      })
    );
    expect(out.steps).toEqual([]); // runtime is scratch: nothing to escalate
    expect(calls).toEqual([]);
  });

  it("escalates the image behind a stage chain (FROM base AS final)", async () => {
    const calls: string[] = [];
    await m.escalateBase(
      ctx({ dockerfile: "FROM nginx:1.29.8-alpine AS base\nFROM base AS final\n", deploy: fakeDeploy({ "1.30.7-alpine": [] }, { calls }) })
    );
    expect(calls).toEqual(["1.30.7-alpine"]);
  });

  it("quarantined app: candidates run keepOffline; a blocked one leaves the app quarantined", async () => {
    const seen: boolean[] = [];
    const inner = fakeDeploy({ "1.30.7-alpine": [f("CVE-KEV")] });
    const deploy = (async (input: any) => {
      seen.push(!!input.keepOffline);
      m.updateApp(input.app.id, { status: "scanning" }); // what the real deployApp does
      return inner(input);
    }) as unknown as NonNullable<EscalationContext["deploy"]>;
    const c = ctx({ quarantined: true, deploy, tagSource: tags({ "library/nginx": ["1.29.8-alpine", "1.30.7-alpine"] }) });
    m.updateApp(c.app.id, { status: "quarantined" });
    const out = await m.escalateBase(c);
    expect(seen).toEqual([true]);
    expect(out.steps[0].outcome).toBe("blocked");
    expect(m.getApp(c.app.id)?.status).toBe("quarantined");
  });

  it("leaves digest-pinned and floating-major runtime bases alone", async () => {
    const d = "sha256:" + "d".repeat(64);
    for (const df of [`FROM nginx:1.29.8-alpine@${d}\n`, "FROM nginx:latest\n", "FROM nginx\n"]) {
      const calls: string[] = [];
      const out = await m.escalateBase(ctx({ dockerfile: df, deploy: fakeDeploy({}, { calls }) }));
      expect(out.steps).toEqual([]);
      expect(calls).toEqual([]);
    }
  });

  it("registry failure is reported as a step, never thrown", async () => {
    const out = await m.escalateBase(
      ctx({ tagSource: async () => { throw new Error("hub down"); }, deploy: fakeDeploy({}) })
    );
    expect(out.steps[0]).toMatchObject({ outcome: "failed" });
    expect(out.steps[0].detail).toContain("hub down");
  });
});
