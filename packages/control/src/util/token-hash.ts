import { createHash, timingSafeEqual } from "node:crypto";
import { nanoid } from "nanoid";

/**
 * Token storage (S10). A token is shown once, when it is made, and only its
 * SHA-256 is kept. The tokens are 32 random characters (about 190 bits), so
 * a plain fast hash is enough: there is nothing to brute-force, and a slow
 * KDF would only make every API call slower. A read-only copy of the database
 * (a backup, a leaked volume) therefore gives away no usable key.
 */

/** The kinds of token Runway issues, by prefix. */
export type TokenKind = "app-key" | "dev-token" | "user-token";

export const TOKEN_PREFIX: Record<TokenKind, string> = {
  "app-key": "rwy_",
  "dev-token": "rwd_",
  "user-token": "rwu_",
};

/** A fresh token of the given kind. */
export function newToken(kind: TokenKind): string {
  return `${TOKEN_PREFIX[kind]}${nanoid(32)}`;
}

/** Which kind a presented bearer value claims to be, by its prefix; null if none. */
export function tokenKindOf(presented: string): TokenKind | null {
  for (const kind of Object.keys(TOKEN_PREFIX) as TokenKind[]) {
    if (presented.startsWith(TOKEN_PREFIX[kind])) return kind;
  }
  return null;
}

/** Hex SHA-256 of a token. */
export function hashToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

/**
 * Compare two hex digests in constant time. Both are fixed-length hashes, so
 * a length mismatch (a malformed value) is simply "not equal".
 */
export function safeEqualHex(a: string, b: string): boolean {
  const x = Buffer.from(a, "hex");
  const y = Buffer.from(b, "hex");
  if (x.length === 0 || x.length !== y.length) return false;
  return timingSafeEqual(x, y);
}

/**
 * The last four characters, kept so a person can tell two keys apart in a
 * list ("...Ab3x"). Not enough to help a guess: four of 32 characters.
 */
export function tokenHint(token: string): string {
  return token.slice(-4);
}

/**
 * What the old plaintext column holds once the secret has moved to its hash.
 * The column is NOT NULL and UNIQUE, so it keeps a distinct non-secret value.
 */
export function placeholderFor(id: string): string {
  return `hashed:${id}`;
}

export function isPlaceholder(value: string): boolean {
  return value.startsWith("hashed:");
}
