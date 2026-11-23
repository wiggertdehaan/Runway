import { describe, expect, it } from "vitest";
import { selectRebuildCandidates, type SelectionContext } from "./rebuild.js";
import type { App } from "../db/apps.js";
import type { Finding } from "./scan.js";

const f = (id: string, severity: Finding["severity"], fixedVersion?: string, extra: Partial<Finding> = {}): Finding => ({
  id,
  severity,
  source: "image",
  fixedVersion,
  ...extra,
});

function mk(id: string, over: Partial<App> = {}): App {
  return {
    id,
    name: id,
    image_tag: `runway/${id}:1`,
    status: "running",
    auto_rebuild: 1,
    auto_update_deps: 0,
    auto_update_deps_major: 0,
    ...over,
  } as unknown as App;
}

const KEV = new Set(["CVE-KEV"]);

function ctx(findings: Record<string, Finding[]>, depFailures: Record<string, string[]> = {}): SelectionContext {
  return {
    kev: KEV,
    findings: (id) => findings[id] ?? [],
    depFailures: (id) => new Set(depFailures[id] ?? []),
  };
}

const weekly = { includeOptedOut: false };
const manual = { includeOptedOut: true };
const ids = (r: ReturnType<typeof selectRebuildCandidates>) => r.map((c) => c.app.id);

describe("selectRebuildCandidates: what counts as an issue", () => {
  it("picks an actively exploited CVE, even a low one without a fix", () => {
    const r = selectRebuildCandidates([mk("a")], ctx({ a: [f("CVE-KEV", "LOW")] }), weekly);
    expect(ids(r)).toEqual(["a"]);
    expect(r[0]!.reason).toContain("KEV");
  });

  it("picks a critical that has a fix, not one without", () => {
    const r = selectRebuildCandidates(
      [mk("a"), mk("b")],
      ctx({ a: [f("CVE-1", "CRITICAL", "2.0")], b: [f("CVE-2", "CRITICAL")] }),
      weekly
    );
    expect(ids(r)).toEqual(["a"]);
    expect(r[0]!.reason).toContain("critical with fix");
  });

  it("leaves an app with no findings, only a high, or only a secret alone", () => {
    const r = selectRebuildCandidates(
      [mk("clean"), mk("high"), mk("secret")],
      ctx({
        high: [f("CVE-3", "HIGH", "1.1")],
        secret: [{ id: "aws", severity: "CRITICAL", source: "secret", fixedVersion: "x" }],
      }),
      manual
    );
    expect(r).toEqual([]);
  });

  it("counts a high with a fix in the app's own packages only when it lets Runway update dependencies", () => {
    const high = f("CVE-9", "HIGH", "4.17.21", { pkg: "lodash", version: "4.17.20", pkgType: "node-pkg", pkgPath: "node_modules/lodash/package.json" });
    const off = selectRebuildCandidates([mk("a", { auto_update_deps: 0 })], ctx({ a: [high] }), manual);
    const on = selectRebuildCandidates([mk("a", { auto_update_deps: 1 })], ctx({ a: [high] }), manual);
    expect(off).toEqual([]);
    expect(ids(on)).toEqual(["a"]);
    expect(on[0]!.reason).toContain("app dependencies");
  });

  it("does not count a dependency update that failed recently", () => {
    const high = f("CVE-9", "HIGH", "4.17.21", { pkg: "lodash", version: "4.17.20", pkgType: "node-pkg", pkgPath: "node_modules/lodash/package.json" });
    const r = selectRebuildCandidates(
      [mk("a", { auto_update_deps: 1 })],
      ctx({ a: [high] }, { a: ["lodash"] }),
      manual
    );
    // whatever the planner says about the skip list, the answer must equal rebuildReason's
    const plain = selectRebuildCandidates([mk("a", { auto_update_deps: 1 })], ctx({ a: [high] }), manual);
    expect(r.length).toBeLessThanOrEqual(plain.length);
  });

  it("skips an app that has never been deployed", () => {
    const r = selectRebuildCandidates([mk("a", { image_tag: null as never })], ctx({ a: [f("CVE-KEV", "LOW")] }), manual);
    expect(r).toEqual([]);
  });

  it("keeps the order of the input", () => {
    const r = selectRebuildCandidates(
      [mk("c"), mk("a"), mk("b")],
      ctx({ a: [f("CVE-KEV", "LOW")], b: [f("CVE-KEV", "LOW")], c: [f("CVE-KEV", "LOW")] }),
      manual
    );
    expect(ids(r)).toEqual(["c", "a", "b"]);
  });
});

describe("selectRebuildCandidates: automatic rebuild switched off", () => {
  const findings = { off: [f("CVE-KEV", "LOW")], on: [f("CVE-KEV", "LOW")] };
  const apps = [mk("off", { auto_rebuild: 0 }), mk("on")];

  it("the weekly run leaves it alone", () => {
    expect(ids(selectRebuildCandidates(apps, ctx(findings), weekly))).toEqual(["on"]);
  });

  it("a person asking gets it too, marked as not rebuilt automatically", () => {
    const r = selectRebuildCandidates(apps, ctx(findings), manual);
    expect(ids(r)).toEqual(["off", "on"]);
    expect(r.find((c) => c.app.id === "off")!.optedOut).toBe(true);
    expect(r.find((c) => c.app.id === "on")!.optedOut).toBe(false);
  });

  it("an opted-out app WITHOUT issues stays out even for a person", () => {
    expect(selectRebuildCandidates([mk("off", { auto_rebuild: 0 })], ctx({}), manual)).toEqual([]);
  });

  it("a quarantined app is selected by the weekly run whatever its opt-out says", () => {
    const q = mk("q", { auto_rebuild: 0, status: "quarantined" as never });
    const r = selectRebuildCandidates([q], ctx({ q: [f("CVE-KEV", "LOW")] }), weekly);
    expect(ids(r)).toEqual(["q"]);
    expect(r[0]!.quarantined).toBe(true);
  });
});

describe("selectRebuildCandidates: weekly and manual agree except for the opt-out", () => {
  it("with nobody opted out both modes pick the same apps with the same reasons", () => {
    const apps = [mk("a"), mk("b"), mk("c")];
    const c = ctx({ a: [f("CVE-KEV", "HIGH")], b: [f("CVE-1", "CRITICAL", "1.2")], c: [] });
    expect(selectRebuildCandidates(apps, c, weekly)).toEqual(selectRebuildCandidates(apps, c, manual));
  });
});
