import { describe, it, expect } from "vitest";
import {
  effectiveThreshold,
  isValidThreshold,
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
