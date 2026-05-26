import { describe, it, expect } from "vitest";
import { pickSourcesToPrune } from "./source.js";

describe("pickSourcesToPrune", () => {
  it("returns nothing when within the keep window", () => {
    expect(pickSourcesToPrune([1, 2, 3], 10)).toEqual([]);
    expect(pickSourcesToPrune([1, 2, 3], 3)).toEqual([]);
  });

  it("prunes the oldest beyond the keep window, regardless of input order", () => {
    expect(pickSourcesToPrune([5, 1, 3, 2, 4], 2)).toEqual([3, 2, 1]);
  });

  it("keeps the most recent ids by numeric value, not insertion order", () => {
    // keep=1 should retain the highest id (5) and prune the rest
    expect(pickSourcesToPrune([2, 5, 1], 1)).toEqual([2, 1]);
  });

  it("prunes everything when keep is 0", () => {
    expect(pickSourcesToPrune([3, 1, 2], 0)).toEqual([3, 2, 1]);
  });

  it("handles an empty list", () => {
    expect(pickSourcesToPrune([], 10)).toEqual([]);
  });
});
