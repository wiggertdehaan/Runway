import { describe, it, expect } from "vitest";
import { diffNewSevereFindings } from "./periodic-scanner.js";
import type { Finding } from "./scan.js";

const f = (
  id: string,
  severity: Finding["severity"],
  source: Finding["source"] = "image",
): Finding => ({ id, severity, source });

describe("diffNewSevereFindings", () => {
  it("returns nothing when current is empty", () => {
    expect(diffNewSevereFindings([], [])).toEqual({
      newCriticals: [],
      newHighs: [],
    });
  });

  it("treats the first scan as all-new (no previous baseline)", () => {
    const result = diffNewSevereFindings(
      [],
      [f("CVE-1", "HIGH"), f("CVE-2", "CRITICAL")],
    );
    expect(result.newHighs.map((x) => x.id)).toEqual(["CVE-1"]);
    expect(result.newCriticals.map((x) => x.id)).toEqual(["CVE-2"]);
  });

  it("ignores LOW/MEDIUM/UNKNOWN entirely", () => {
    const result = diffNewSevereFindings(
      [],
      [f("CVE-A", "LOW"), f("CVE-B", "MEDIUM"), f("CVE-C", "UNKNOWN")],
    );
    expect(result.newHighs).toEqual([]);
    expect(result.newCriticals).toEqual([]);
  });

  it("subtracts previously-seen findings", () => {
    const prev = [f("CVE-1", "HIGH"), f("CVE-2", "CRITICAL")];
    const curr = [
      f("CVE-1", "HIGH"),
      f("CVE-2", "CRITICAL"),
      f("CVE-3", "HIGH"),
    ];
    const result = diffNewSevereFindings(prev, curr);
    expect(result.newHighs.map((x) => x.id)).toEqual(["CVE-3"]);
    expect(result.newCriticals).toEqual([]);
  });

  it("dedupes the same CVE appearing twice in the current scan", () => {
    const result = diffNewSevereFindings(
      [],
      [f("CVE-9", "HIGH"), f("CVE-9", "HIGH")],
    );
    expect(result.newHighs.map((x) => x.id)).toEqual(["CVE-9"]);
  });

  it("treats the same CVE-id at different severities as separate keys", () => {
    // CVE bumped from HIGH last time to CRITICAL now → counts as new CRITICAL.
    const prev = [f("CVE-7", "HIGH")];
    const curr = [f("CVE-7", "CRITICAL")];
    const result = diffNewSevereFindings(prev, curr);
    expect(result.newCriticals.map((x) => x.id)).toEqual(["CVE-7"]);
    expect(result.newHighs).toEqual([]);
  });

  it("does not flag a CVE that was previously CRITICAL but is now HIGH", () => {
    // Downgrade is not a new finding. The HIGH entry was not in the
    // prev set as HIGH, only as CRITICAL — but the downgrade itself
    // shouldn't fire a webhook ("good news"). The current heuristic
    // does flag it as new HIGH; document that here so the choice is
    // explicit and a future change is deliberate.
    const prev = [f("CVE-5", "CRITICAL")];
    const curr = [f("CVE-5", "HIGH")];
    const result = diffNewSevereFindings(prev, curr);
    expect(result.newHighs.map((x) => x.id)).toEqual(["CVE-5"]);
    expect(result.newCriticals).toEqual([]);
  });
});
