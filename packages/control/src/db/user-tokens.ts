import { customAlphabet } from "nanoid";
import { db } from "./index.js";
import { hashToken, newToken, safeEqualHex, tokenHint } from "../util/token-hash.js";
import {
  USER_TOKEN_DEFAULT_DAYS,
  USER_TOKEN_MAX_DAYS,
  USER_TOKEN_MAX_PER_USER,
  type Scope,
} from "../util/token-scopes.js";

/**
 * User tokens (`rwu_…`, S18): one token for one person, good for every app
 * that person may see on this Runway server. Stored as a hash, expires,
 * records when it was last used, and can be revoked by its owner and by an
 * administrator. Revoking keeps the row (who, when) so the audit trail and the
 * list can still say what happened; a revoked token never authenticates again.
 */

export interface UserToken {
  id: string;
  user_id: string;
  token_hash: string;
  token_hint: string;
  name: string;
  scope: Scope;
  expires_at: string;
  last_used_at: string | null;
  revoked_at: string | null;
  revoked_by: string | null;
  created_at: string;
}

/** What may be listed: never the hash. */
export type UserTokenSummary = Omit<UserToken, "token_hash">;

const generateId = customAlphabet("0123456789abcdefghijklmnopqrstuvwxyz", 12);

function sqliteTime(ms: number): string {
  return new Date(ms).toISOString().slice(0, 19).replace("T", " ");
}

function parseSqliteTime(value: string): number {
  return Date.parse(value.replace(" ", "T") + "Z");
}

export class TokenLimitError extends Error {}

export function createUserToken(
  userId: string,
  name: string,
  scope: Scope,
  days = USER_TOKEN_DEFAULT_DAYS,
  now = Date.now(),
): { id: string; token: string; name: string; scope: Scope; expires_at: string } {
  const active = db
    .prepare(
      `SELECT COUNT(*) AS n FROM user_tokens WHERE user_id = ? AND revoked_at IS NULL AND expires_at > ?`,
    )
    .get(userId, sqliteTime(now)) as { n: number };
  if (active.n >= USER_TOKEN_MAX_PER_USER) {
    throw new TokenLimitError(`At most ${USER_TOKEN_MAX_PER_USER} active tokens per person.`);
  }
  const id = generateId();
  const token = newToken("user-token");
  const lifetime = Math.min(Math.max(Math.floor(days) || USER_TOKEN_DEFAULT_DAYS, 1), USER_TOKEN_MAX_DAYS);
  const expires_at = sqliteTime(now + lifetime * 86_400_000);
  db.prepare(
    `INSERT INTO user_tokens (id, user_id, token_hash, token_hint, name, scope, expires_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(id, userId, hashToken(token), tokenHint(token), name.trim(), scope, expires_at);
  return { id, token, name: name.trim(), scope, expires_at };
}

/**
 * The live token for a presented value, or undefined: unknown, revoked or
 * expired. A token of a user who no longer exists is gone with the user
 * (foreign key cascade), so it is not found either.
 */
export function getUserTokenByToken(token: string, now = Date.now()): UserToken | undefined {
  const hash = hashToken(token);
  const row = db
    .prepare(`SELECT * FROM user_tokens WHERE token_hash = ?`)
    .get(hash) as unknown as UserToken | undefined;
  if (!row || !safeEqualHex(row.token_hash, hash)) return undefined;
  if (row.revoked_at) return undefined;
  if (parseSqliteTime(row.expires_at) <= now) return undefined;
  return row;
}

export function touchUserToken(id: string): void {
  db.prepare(`UPDATE user_tokens SET last_used_at = datetime('now') WHERE id = ?`).run(id);
}

const SUMMARY_COLUMNS = `id, user_id, token_hint, name, scope, expires_at, last_used_at,
                         revoked_at, revoked_by, created_at`;

export function listUserTokens(userId: string): UserTokenSummary[] {
  return db
    .prepare(
      `SELECT ${SUMMARY_COLUMNS} FROM user_tokens WHERE user_id = ? ORDER BY created_at DESC, id DESC`,
    )
    .all(userId) as unknown as UserTokenSummary[];
}

export function listAllUserTokens(): Array<UserTokenSummary & { username: string | null }> {
  return db
    .prepare(
      `SELECT t.id, t.user_id, t.token_hint, t.name, t.scope, t.expires_at, t.last_used_at,
              t.revoked_at, t.revoked_by, t.created_at, u.username AS username
       FROM user_tokens t LEFT JOIN users u ON u.id = t.user_id
       ORDER BY t.created_at DESC, t.id DESC`,
    )
    .all() as unknown as Array<UserTokenSummary & { username: string | null }>;
}

export function getUserTokenById(id: string): UserTokenSummary | undefined {
  return db
    .prepare(`SELECT ${SUMMARY_COLUMNS} FROM user_tokens WHERE id = ?`)
    .get(id) as unknown as UserTokenSummary | undefined;
}

/**
 * Revoke a token. `byUserId` is who did it (the owner, or an administrator).
 * The caller checks that the person may; this only records it. Returns the
 * token's owner when something was revoked, null when there was nothing live.
 */
export function revokeUserToken(id: string, byUserId: string): { user_id: string } | null {
  const row = db
    .prepare(`SELECT user_id FROM user_tokens WHERE id = ? AND revoked_at IS NULL`)
    .get(id) as { user_id: string } | undefined;
  if (!row) return null;
  db.prepare(
    `UPDATE user_tokens SET revoked_at = datetime('now'), revoked_by = ? WHERE id = ?`,
  ).run(byUserId, id);
  return row;
}

/** Revoke every token of a person (sign-out everywhere, a leaving employee). */
export function revokeAllUserTokens(userId: string, byUserId: string): number {
  return db
    .prepare(
      `UPDATE user_tokens SET revoked_at = datetime('now'), revoked_by = ?
       WHERE user_id = ? AND revoked_at IS NULL`,
    )
    .run(byUserId, userId).changes as number;
}
