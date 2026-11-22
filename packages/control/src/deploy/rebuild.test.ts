import { describe, it, expect } from "vitest";
import { evaluateRebuildGate, rebuildReason, snapshot, summarizeRun } from "./rebuild.js";
import type { ScanResult } from "./scan.js";
import type { Finding } from "./scan.js";
import type { RebuildAppResult } from "../db/rebuild-runs.js";

const f = (
  id: string,
  severity: Finding["severity"],
  fixedVersion?: string,
  source: Finding["source"] = "image"
): Finding => ({ id, severity, source, fixedVersion });

const kev = new Set(["CVE-1"]);

describe("rebuildReason", () => {
  it("null when nothing exploited and no fixable critical", () => {
    expect(rebuildReason([f("CVE-5", "HIGH", "1.2"), f("CVE-6", "CRITICAL")], kev)).toBeNull();
  });
  it("picks KEV even without a fix or high severity", () => {
    expect(rebuildReason([f("CVE-1", "LOW")], kev)).toContain("KEV");
  });
  it("picks critical with a fixed version", () => {
    expect(rebuildReason([f("CVE-7", "CRITICAL", "2.0")], kev)).toContain("critical with fix");
  });
  it("counts both reasons", () => {
    const r = rebuildReason([f("CVE-1", "HIGH"), f("CVE-7", "CRITICAL", "2.0")], kev)!;
    expect(r).toContain("KEV");
    expect(r).toContain("critical with fix");
  });
  it("ignores secret/misconfig findings", () => {
    expect(rebuildReason([f("CVE-1", "CRITICAL", "1", "secret")], kev)).toBeNull();
  });
  it("null for an empty scan", () => {
    expect(rebuildReason([], kev)).toBeNull();
  });
});

describe("snapshot", () => {
  it("counts severities and KEV hits over image findings only", () => {
    const s = snapshot(
      [f("CVE-1", "CRITICAL"), f("CVE-2", "HIGH"), f("CVE-3", "HIGH"), f("X", "CRITICAL", undefined, "secret")],
      kev
    );
    expect(s.counts.critical).toBe(1);
    expect(s.counts.high).toBe(2);
    expect(s.kev).toBe(1);
  });
});

describe("summarizeRun", () => {
  const counts = (critical: number) => ({ critical, high: 0, medium: 0, low: 0, unknown: 0 });
  const r = (o: Partial<RebuildAppResult>): RebuildAppResult => ({
    app_id: "a1", app_name: "Alpha", outcome: "rebuilt", before: null, after: null, ...o,
  });
  it("says so when nothing was rebuilt", () => {
    expect(summarizeRun("scheduled", [])).toContain("no apps needed");
  });
  it("shows before→after and the failure detail", () => {
    const text = summarizeRun("manual", [
      r({ before: { counts: counts(3), kev: 2 }, after: { counts: counts(0), kev: 0 } }),
      r({ app_id: "b", app_name: null, outcome: "rolled_back", detail: "healthcheck failing" }),
    ]);
    expect(text).toContain("1 rebuilt, 1 rolled back");
    expect(text).toContain("Alpha: rebuilt (critical 3→0, KEV 2→0)");
    expect(text).toContain("b: rolled back: healthcheck failing");
  });
});

describe("evaluateRebuildGate", () => {
  const scan = (findings: Finding[], status: ScanResult["status"] = "blocked"): ScanResult => ({
    status,
    counts: { critical: 0, high: 0, medium: 0, low: 0, unknown: 0 },
    findings,
  });
  const kevSet = new Set(["CVE-KEV"]);

  it("allows an equal result even when the threshold would have blocked it", () => {
    const cur = [f("CVE-1", "CRITICAL", "9")];
    const v = evaluateRebuildGate(cur, scan([f("CVE-1", "CRITICAL", "9")], "blocked"), kevSet);
    expect(v.allow).toBe(true);
  });
  it("allows a strictly better build (4C -> fewer, the Fennomotor case)", () => {
    const cur = [f("CVE-1", "CRITICAL"), f("CVE-2", "CRITICAL"), f("CVE-3", "HIGH")];
    expect(evaluateRebuildGate(cur, scan([f("CVE-2", "CRITICAL")]), kevSet).allow).toBe(true);
  });
  it("blocks a new CRITICAL that the running version does not have", () => {
    const v = evaluateRebuildGate([f("CVE-1", "CRITICAL")], scan([f("CVE-1", "CRITICAL"), f("CVE-9", "CRITICAL")]), kevSet);
    expect(v.allow).toBe(false);
    expect(v.reason).toContain("1 new critical (CVE-9)");
  });
  it("a HIGH that became CRITICAL counts as a new critical", () => {
    const v = evaluateRebuildGate([f("CVE-5", "HIGH")], scan([f("CVE-5", "CRITICAL")]), kevSet);
    expect(v.allow).toBe(false);
  });
  it("blocks a new KEV even at low severity, but not a KEV the running version already has", () => {
    expect(evaluateRebuildGate([], scan([f("CVE-KEV", "LOW")]), kevSet).allow).toBe(false);
    expect(evaluateRebuildGate([f("CVE-KEV", "LOW")], scan([f("CVE-KEV", "LOW")]), kevSet).allow).toBe(true);
  });
  it("new HIGH/MEDIUM findings alone do not block", () => {
    expect(evaluateRebuildGate([], scan([f("CVE-7", "HIGH"), f("CVE-8", "MEDIUM")], "warned"), kevSet).allow).toBe(true);
  });
  it("ignores secret/misconfig findings", () => {
    expect(evaluateRebuildGate([], scan([f("DS002", "CRITICAL", undefined, "misconfig")]), kevSet).allow).toBe(true);
  });
  it("fails closed without a baseline or when the new scan was skipped", () => {
    expect(evaluateRebuildGate(null, scan([]), kevSet).allow).toBe(false);
    expect(evaluateRebuildGate([], scan([], "skipped"), kevSet).allow).toBe(false);
  });
  it("caps the id list in the reason", () => {
    const next = scan(["A", "B", "C", "D", "E"].map((id) => f(`CVE-${id}`, "CRITICAL")));
    expect(evaluateRebuildGate([], next, kevSet).reason).toContain("+2 more");
  });
});

describe("summarizeRun with base patches", () => {
  it("mentions an automatically raised base image", () => {
    const text = summarizeRun("scheduled", [
      {
        app_id: "a", app_name: "Fennomotor", outcome: "rebuilt", before: null, after: null,
        patched: [{ from: "nginx:1.30.6-alpine", to: "nginx:1.30.7-alpine" }],
      },
    ]);
    expect(text).toContain("[base nginx:1.30.6-alpine→nginx:1.30.7-alpine]");
  });
  it("shows the gate reason for a blocked app", () => {
    const text = summarizeRun("manual", [
      { app_id: "a", app_name: "X", outcome: "blocked", before: null, after: null, detail: "new build is worse than the running version: 1 new critical (CVE-9)" },
    ]);
    expect(text).toContain("X: blocked: new build is worse");
  });
});

describe("rebuildReason with dependency updates", () => {
  const dep = (id: string, severity: Finding["severity"], pkgType: string, fixedVersion?: string): Finding => ({
    id, severity, source: "image", pkg: "p", version: "1.0.0", fixedVersion, pkgType,
  });
  it("selects a fixable HIGH in an app package only when the app allows updates", () => {
    const findings = [dep("CVE-5", "HIGH", "python-pkg", "1.0.1")];
    expect(rebuildReason(findings, kev)).toBeNull();
    expect(rebuildReason(findings, kev, { deps: true })).toBe("1 high with fix in app dependencies");
  });
  it("does not select for OS packages, or for a HIGH without a fix", () => {
    expect(rebuildReason([dep("CVE-5", "HIGH", "alpine", "1.0.1")], kev, { deps: true })).toBeNull();
    expect(rebuildReason([dep("CVE-5", "HIGH", "node-pkg")], kev, { deps: true })).toBeNull();
  });
});

describe("summarizeRun with dependency updates", () => {
  const base: RebuildAppResult = { app_id: "a", app_name: "meldingen", outcome: "rebuilt", before: null, after: null };
  it("lists what was raised and what was not", () => {
    const text = summarizeRun("scheduled", [
      {
        ...base,
        deps: [
          { ecosystem: "python", pkg: "setuptools", from: "70.3.0", to: "78.1.1", kind: "compatible", outcome: "applied" },
          { ecosystem: "python", pkg: "pillow", from: "12.3.0", to: "13.0.0", kind: "major", outcome: "unhealthy", detail: "x" },
          { ecosystem: "python", pkg: "other", from: "", to: "", kind: "compatible", outcome: "skipped", detail: "y" },
        ],
      },
    ]);
    expect(text).toContain("[deps setuptools 70.3.0→78.1.1]");
    expect(text).toContain("[deps not applied: pillow 13.0.0 unhealthy]");
    expect(text).not.toContain("other");
  });
});
