import { describe, it, expect } from "vitest";
import { escalationTargets, evaluateEscalationGate, requireKevFree, evaluateDepGate } from "./gate.js";
import type { Finding, ScanResult } from "./scan.js";

const f = (id: string, severity: Finding["severity"], fixedVersion?: string, source: Finding["source"] = "image"): Finding => ({
  id, severity, source, fixedVersion,
});
const scan = (findings: Finding[], status: ScanResult["status"] = "warned"): ScanResult => ({
  status, findings, counts: { critical: 0, high: 0, medium: 0, low: 0, unknown: 0 },
});
const kev = new Set(["CVE-KEV"]);

describe("escalationTargets", () => {
  it("KEV of any severity and CRITICAL-with-fix; nothing else", () => {
    const t = escalationTargets(
      [f("CVE-KEV", "LOW"), f("CVE-C1", "CRITICAL", "2"), f("CVE-C2", "CRITICAL"), f("CVE-H", "HIGH", "1"), f("DS1", "CRITICAL", "1", "misconfig")],
      kev
    );
    expect(t.sort()).toEqual(["CVE-C1", "CVE-KEV"]);
  });
  it("empty when clean", () => {
    expect(escalationTargets([f("CVE-H", "HIGH", "1")], kev)).toEqual([]);
  });
});

describe("evaluateEscalationGate", () => {
  const targets = ["CVE-KEV", "CVE-C1"];
  it("allows a minor that removes every target and is not worse", () => {
    const v = evaluateEscalationGate([f("CVE-KEV", "HIGH"), f("CVE-C1", "CRITICAL", "2")], scan([f("CVE-M", "MEDIUM")]), kev, targets, "1.30");
    expect(v.allow).toBe(true);
  });
  it("blocks a minor that leaves a target behind, naming it", () => {
    const v = evaluateEscalationGate([f("CVE-KEV", "HIGH"), f("CVE-C1", "CRITICAL", "2")], scan([f("CVE-KEV", "HIGH")]), kev, targets, "1.30");
    expect(v.allow).toBe(false);
    expect(v.reason).toContain("minor 1.30 still has CVE-KEV");
  });
  it("blocks a minor that is worse even if it fixes the targets", () => {
    const v = evaluateEscalationGate([f("CVE-KEV", "HIGH")], scan([f("CVE-NEW", "CRITICAL", "9")]), kev, ["CVE-KEV"], "1.30");
    expect(v.allow).toBe(false);
    expect(v.reason).toContain("worse than the running version");
  });
});

describe("requireKevFree", () => {
  it("passes an allowed verdict only without KEV findings", () => {
    const ok = { allow: true, reason: "ok" };
    expect(requireKevFree(ok, scan([f("CVE-M", "MEDIUM")]), kev).allow).toBe(true);
    const v = requireKevFree(ok, scan([f("CVE-KEV", "LOW")]), kev);
    expect(v.allow).toBe(false);
    expect(v.reason).toContain("quarantined");
    expect(v.reason).toContain("CVE-KEV");
  });
  it("keeps an existing block untouched", () => {
    const blocked = { allow: false, reason: "worse" };
    expect(requireKevFree(blocked, scan([]), kev)).toBe(blocked);
  });
});

describe("evaluateDepGate", () => {
  const current = [f("CVE-A", "CRITICAL", "2"), f("CVE-B", "HIGH", "2")];
  it("a batch passes when at least one targeted finding is gone", () => {
    const v = evaluateDepGate(current, scan([f("CVE-B", "HIGH", "2")]), kev, ["CVE-A", "CVE-B"], false);
    expect(v.allow).toBe(true);
    expect(v.reason).toContain("1 of 2");
  });
  it("a batch that removed nothing is refused", () => {
    const v = evaluateDepGate(current, scan(current), kev, ["CVE-A", "CVE-B"], false);
    expect(v.allow).toBe(false);
    expect(v.reason).toContain("removed none");
  });
  it("a major update must remove everything it was for", () => {
    expect(evaluateDepGate(current, scan([f("CVE-B", "HIGH", "2")]), kev, ["CVE-A", "CVE-B"], true).allow).toBe(false);
    expect(evaluateDepGate(current, scan([]), kev, ["CVE-A", "CVE-B"], true).allow).toBe(true);
  });
  it("is never more lenient than the rebuild gate", () => {
    const worse = scan([f("CVE-NEW", "CRITICAL", "9")]);
    expect(evaluateDepGate(current, worse, kev, ["CVE-A"], false).allow).toBe(false);
    expect(evaluateDepGate(null, scan([]), kev, ["CVE-A"], true).allow).toBe(false);
    expect(evaluateDepGate(current, scan([], "skipped"), kev, ["CVE-A"], true).allow).toBe(false);
  });
  it("matches finding ids case-insensitively", () => {
    expect(evaluateDepGate(current, scan([f("cve-a", "CRITICAL", "2")]), kev, ["CVE-A"], true).allow).toBe(false);
  });
});
