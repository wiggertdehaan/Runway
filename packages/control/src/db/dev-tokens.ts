import { customAlphabet } from "nanoid";
import { db } from "./index.js";
import {
  hashToken,
  newToken,
  placeholderFor,
  safeEqualHex,
  tokenHint,
} from "../util/token-hash.js";

/**
 * Developer tokens (`rwd_…`): the skills MCP (/mcp). They belong to a person,
 * grant read access to skill text only, and (S10, S18) are stored as hashes,
 * expire, and can be revoked by their owner or by an administrator.
 *
 * Runway-API access for a person is a different token (`rwu_…`, user-tokens.ts)
 * with scopes; a developer token cannot call /api/v1.
 */

export interface DevToken {
  id: string;
  user_id: string;
  /** The non-secret placeholder; never the token. */
  token: string;
  token_hash: string | null;
  token_hint: string | null;
  name: string;
  expires_at: string | null;
  last_used_at: string | null;
  created_at: string;
}

/** What is safe to list: no secret, no hash. */
export type DevTokenSummary = Omit<DevToken, "token" | "token_hash">;

const generateTokenId = customAlphabet(
  "0123456789abcdefghijklmnopqrstuvwxyz",
  12,
);

/** Default and longest lifetime of a new developer token, in days. */
export const DEV_TOKEN_DEFAULT_DAYS = 90;
export const DEV_TOKEN_MAX_DAYS = 365;

export interface CreatedDevToken {
  id: string;
  /** Shown once, here. Not recoverable afterwards. */
  token: string;
  name: string;
  expires_at: string;
}

function sqliteTime(ms: number): string {
  return new Date(ms).toISOString().slice(0, 19).replace("T", " ");
}

function parseSqliteTime(value: string): number {
  return Date.parse(value.replace(" ", "T") + "Z");
}

export function createDevToken(
  userId: string,
  name: string,
  days = DEV_TOKEN_DEFAULT_DAYS,
  now = Date.now(),
): CreatedDevToken {
  const id = generateTokenId();
  const token = newToken("dev-token");
  const lifetime = Math.min(Math.max(Math.floor(days) || DEV_TOKEN_DEFAULT_DAYS, 1), DEV_TOKEN_MAX_DAYS);
  const expires_at = sqliteTime(now + lifetime * 86_400_000);
  db.prepare(
    `INSERT INTO dev_tokens (id, user_id, token, token_hash, token_hint, name, expires_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(id, userId, placeholderFor(id), hashToken(token), tokenHint(token), name.trim(), expires_at);
  return { id, token, name: name.trim(), expires_at };
}

export function listDevTokens(userId: string): DevTokenSummary[] {
  return db
    .prepare(
      `SELECT id, user_id, name, token_hint, expires_at, last_used_at, created_at
       FROM dev_tokens
       WHERE user_id = ?
       ORDER BY created_at DESC`,
    )
    .all(userId) as unknown as DevTokenSummary[];
}

/** Every developer token of everyone, for the administrator's overview. */
export function listAllDevTokens(): Array<DevTokenSummary & { username: string | null }> {
  return db
    .prepare(
      `SELECT t.id, t.user_id, t.name, t.token_hint, t.expires_at, t.last_used_at, t.created_at,
              u.username AS username
       FROM dev_tokens t LEFT JOIN users u ON u.id = t.user_id
       ORDER BY t.created_at DESC`,
    )
    .all() as unknown as Array<DevTokenSummary & { username: string | null }>;
}

/**
 * The row for a presented token, or undefined when it is unknown or has
 * expired. Lookup by hash, then a constant-time confirmation.
 */
export function getDevTokenByToken(token: string, now = Date.now()): DevToken | undefined {
  const hash = hashToken(token);
  const row = db
    .prepare(`SELECT * FROM dev_tokens WHERE token_hash = ?`)
    .get(hash) as unknown as DevToken | undefined;
  if (!row || !row.token_hash || !safeEqualHex(row.token_hash, hash)) return undefined;
  if (row.expires_at && parseSqliteTime(row.expires_at) <= now) return undefined;
  return row;
}

export function touchDevToken(id: string): void {
  db.prepare(
    `UPDATE dev_tokens SET last_used_at = datetime('now') WHERE id = ?`,
  ).run(id);
}

export function deleteDevToken(id: string, userId: string): boolean {
  const result = db
    .prepare(`DELETE FROM dev_tokens WHERE id = ? AND user_id = ?`)
    .run(id, userId);
  return result.changes > 0;
}

/** Revoke by id, whoever owns it. For an administrator; the caller checks the role. */
export function deleteDevTokenAsAdmin(id: string): { user_id: string } | null {
  const row = db.prepare(`SELECT user_id FROM dev_tokens WHERE id = ?`).get(id) as
    | { user_id: string }
    | undefined;
  if (!row) return null;
  db.prepare(`DELETE FROM dev_tokens WHERE id = ?`).run(id);
  return row;
}
