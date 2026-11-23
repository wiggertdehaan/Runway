import { describe, it, expect } from "vitest";
import {
  effectiveThreshold,
  isValidThreshold,
  parseTrivyOutput,
  THRESHOLDS,
  type Threshold,
} from "./scan.js";

describe("isValidThreshold", () => {
  it("accepts every value in THRESHOLDS", () => {
    for (const t of THRESHOLDS) expect(isValidThreshold(t)).toBe(true);
  });

  it("rejects unknown strings, numbers, null, undefined", () => {
    expect(isValidThreshold("severe")).toBe(false);
    expect(isValidThreshold("")).toBe(false);
    expect(isValidThreshold(2)).toBe(false);
    expect(isValidThreshold(null)).toBe(false);
    expect(isValidThreshold(undefined)).toBe(false);
  });
});

describe("effectiveThreshold", () => {
  // Stricter = blocks more = lower numeric order.
  // none = never blocks; low = blocks on low+; critical = only critical.

  it("returns the app threshold when the floor is 'none'", () => {
    expect(effectiveThreshold("medium", "none", false)).toBe("medium");
    expect(effectiveThreshold("none", "none", false)).toBe("none");
  });

  it("returns the app threshold when the app is exempt", () => {
    expect(effectiveThreshold("none", "high", true)).toBe("none");
    expect(effectiveThreshold("critical", "low", true)).toBe("critical");
  });

  it("picks the stricter of the two when not exempt", () => {
    // app=critical (lax) vs floor=high (stricter) → floor wins
    expect(effectiveThreshold("critical", "high", false)).toBe("high");
    // app=low (strict) vs floor=high (less strict) → app wins
    expect(effectiveThreshold("low", "high", false)).toBe("low");
    // equal → either works; impl returns appThreshold
    expect(effectiveThreshold("medium", "medium", false)).toBe("medium");
  });

  it("treats app='none' as the laxest, so a real floor always wins", () => {
    const cases: Threshold[] = ["low", "medium", "high", "critical"];
    for (const floor of cases) {
      expect(effectiveThreshold("none", floor, false)).toBe(floor);
    }
  });
});

describe("parseTrivyOutput", () => {
  it("keeps the package type and path, which tell app packages from OS ones", () => {
    const raw = JSON.stringify({
      Results: [
        { Target: "img (alpine 3.24.4)", Class: "os-pkgs", Type: "alpine", Vulnerabilities: [{ VulnerabilityID: "CVE-1", PkgName: "musl", InstalledVersion: "1.2.5", FixedVersion: "1.2.6", Severity: "HIGH" }] },
        { Target: "Python", Class: "lang-pkgs", Type: "python-pkg", Vulnerabilities: [{ VulnerabilityID: "CVE-2", PkgName: "pillow", InstalledVersion: "12.3.0", FixedVersion: "13.0.0", Severity: "CRITICAL" }] },
        { Target: "Node.js", Class: "lang-pkgs", Type: "node-pkg", Vulnerabilities: [{ VulnerabilityID: "CVE-3", PkgName: "qs", PkgPath: "app/node_modules/qs/package.json", InstalledVersion: "6.14.2", FixedVersion: "6.16.1", Severity: "medium" }] },
      ],
    });
    const out = parseTrivyOutput(raw);
    expect(out.map((x) => x.pkgType)).toEqual(["alpine", "python-pkg", "node-pkg"]);
    expect(out[1].pkgPath).toBeUndefined();
    expect(out[2]).toMatchObject({ pkg: "qs", pkgPath: "app/node_modules/qs/package.json", severity: "MEDIUM", source: "image" });
  });
  it("returns nothing for empty or broken output", () => {
    expect(parseTrivyOutput("")).toEqual([]);
    expect(parseTrivyOutput("not json")).toEqual([]);
  });
});
