/** Showing a fresh key for a few minutes, to one person, from memory only (S10). */
import { beforeEach, describe, expect, it } from "vitest";
import { clearKeyReveals, forgetKey, keyRevealSize, peekKey, rememberKey } from "./key-reveal.js";

beforeEach(() => clearKeyReveals());

describe("key reveal", () => {
  it("gives the key to the person it was made for, and to nobody else", () => {
    rememberKey("app1", "alice", "rwy_secret", 1000);
    expect(peekKey("app1", "alice", 2000)).toBe("rwy_secret");
    expect(peekKey("app1", "bob", 2000)).toBeNull();
    expect(peekKey("app2", "alice", 2000)).toBeNull();
  });

  it("can be read more than once (the home page re-renders every few seconds)", () => {
    rememberKey("app1", "alice", "rwy_secret", 1000);
    expect(peekKey("app1", "alice", 2000)).toBe("rwy_secret");
    expect(peekKey("app1", "alice", 3000)).toBe("rwy_secret");
  });

  it("expires after ten minutes", () => {
    rememberKey("app1", "alice", "rwy_secret", 0);
    expect(peekKey("app1", "alice", 9 * 60_000)).toBe("rwy_secret");
    expect(peekKey("app1", "alice", 10 * 60_000 + 1)).toBeNull();
    expect(keyRevealSize()).toBe(0);
  });

  it("is forgotten on request, and a newer key replaces an older one", () => {
    rememberKey("app1", "alice", "rwy_old", 0);
    rememberKey("app1", "alice", "rwy_new", 1);
    expect(peekKey("app1", "alice", 2)).toBe("rwy_new");
    forgetKey("app1");
    expect(peekKey("app1", "alice", 3)).toBeNull();
  });

  it("is bounded, so a flood of creations cannot grow it without end", () => {
    for (let i = 0; i < 2000; i++) rememberKey(`app${i}`, "alice", `rwy_${i}`, i);
    expect(keyRevealSize()).toBeLessThanOrEqual(501);
  });
});
