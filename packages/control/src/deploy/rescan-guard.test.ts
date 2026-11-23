import { beforeEach, describe, expect, it } from "vitest";
import { activeRescan, endRescan, tryBeginRescan } from "./rescan-guard.js";

beforeEach(() => {
  const a = activeRescan();
  if (a) endRescan(a);
});

describe("rescan guard", () => {
  it("lets one rescan run and refuses a second, for the same or another app", () => {
    expect(tryBeginRescan("a1")).toBe(true);
    expect(activeRescan()).toBe("a1");
    expect(tryBeginRescan("a1")).toBe(false);
    expect(tryBeginRescan("a2")).toBe(false);
  });

  it("frees the slot when the owner of it ends", () => {
    tryBeginRescan("a1");
    endRescan("a2"); // somebody else's end must not free it
    expect(activeRescan()).toBe("a1");
    endRescan("a1");
    expect(activeRescan()).toBeNull();
    expect(tryBeginRescan("a2")).toBe(true);
  });
});
