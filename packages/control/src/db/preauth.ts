import { randomBytes } from "node:crypto";
import { db } from "./index.js";

/**
 * A pre-auth session is a short-lived marker that a user's
 * password check succeeded but they still need to clear a second
 * factor. Fully separate from the real `sessions` table so there
 * is no risk of a half-authenticated cookie being accepted as a
 * full session by any other middleware.
 */

const PREAUTH_TTL_MS = 5 * 60 * 1000;

export interface PreauthSession {
  token: string;
  user_id: string;
  expires_at: string;
}

export function createPreauthSession(userId: string): PreauthSession {
  const token = randomBytes(32).toString("base64url");
  const expiresAt = new Date(Date.now() + PREAUTH_TTL_MS).toISOString();

  db.prepare(
    `INSERT INTO preauth_sessions (token, user_id, expires_at) VALUES (?, ?, ?)`
  ).run(token, userId, expiresAt);

  return { token, user_id: userId, expires_at: expiresAt };
}

export function getPreauthUserId(token: string): string | undefined {
  const row = db
    .prepare(
      `SELECT user_id FROM preauth_sessions
       WHERE token = ? AND expires_at > datetime('now')`
    )
    .get(token) as { user_id: string } | undefined;
  return row?.user_id;
}

export function deletePreauthSession(token: string): void {
  db.prepare(`DELETE FROM preauth_sessions WHERE token = ?`).run(token);
}

export function deleteExpiredPreauth(): void {
  db.prepare(
    `DELETE FROM preauth_sessions WHERE expires_at <= datetime('now')`
  ).run();
}
