/** Token storage helpers (S10): hashing, constant-time compare, prefixes. */
import { describe, expect, it } from "vitest";
import {
  hashToken,
  isPlaceholder,
  newToken,
  placeholderFor,
  safeEqualHex,
  tokenHint,
  tokenKindOf,
  TOKEN_PREFIX,
} from "./token-hash.js";

describe("newToken", () => {
  it("has the prefix of its kind and 32 random characters after it", () => {
    for (const kind of ["app-key", "dev-token", "user-token"] as const) {
      const t = newToken(kind);
      expect(t.startsWith(TOKEN_PREFIX[kind])).toBe(true);
      expect(t.length).toBe(TOKEN_PREFIX[kind].length + 32);
    }
  });
  it("does not repeat", () => {
    const seen = new Set(Array.from({ length: 500 }, () => newToken("user-token")));
    expect(seen.size).toBe(500);
  });
});

describe("tokenKindOf", () => {
  it("tells the three kinds apart by prefix and ignores anything else", () => {
    expect(tokenKindOf("rwy_abc")).toBe("app-key");
    expect(tokenKindOf("rwd_abc")).toBe("dev-token");
    expect(tokenKindOf("rwu_abc")).toBe("user-token");
    expect(tokenKindOf("abc")).toBeNull();
    expect(tokenKindOf("")).toBeNull();
    expect(tokenKindOf("RWU_abc")).toBeNull();
  });
});

describe("hashToken", () => {
  it("is a stable 64-character hex digest that does not contain the token", () => {
    const t = newToken("app-key");
    const h = hashToken(t);
    expect(h).toMatch(/^[0-9a-f]{64}$/);
    expect(hashToken(t)).toBe(h);
    expect(h).not.toContain(t.slice(4, 20));
  });
  it("differs for different tokens", () => {
    expect(hashToken("rwy_a")).not.toBe(hashToken("rwy_b"));
  });
});

describe("safeEqualHex", () => {
  it("is true only for the same digest", () => {
    const h = hashToken("rwy_x");
    expect(safeEqualHex(h, h)).toBe(true);
    expect(safeEqualHex(h, hashToken("rwy_y"))).toBe(false);
  });
  it("is false, and does not throw, for malformed or different-length input", () => {
    const h = hashToken("rwy_x");
    expect(safeEqualHex(h, "")).toBe(false);
    expect(safeEqualHex("", "")).toBe(false);
    expect(safeEqualHex(h, h.slice(0, 10))).toBe(false);
    expect(safeEqualHex("zz", "zz")).toBe(false);
  });
});

describe("hint and placeholder", () => {
  it("keeps four characters, enough to tell keys apart and too few to help a guess", () => {
    expect(tokenHint("rwy_abcdefghijWXYZ")).toBe("WXYZ");
  });
  it("marks the old column as no longer holding a secret", () => {
    expect(isPlaceholder(placeholderFor("abc123"))).toBe(true);
    expect(isPlaceholder("rwy_realkey")).toBe(false);
  });
});
