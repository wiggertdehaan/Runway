import { describe, it, expect } from "vitest";
import { rebuildReason, snapshot, summarizeRun } from "./rebuild.js";
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
