import { randomBytes } from "node:crypto";
import { db } from "./index.js";
import type { User } from "./users.js";
import { deleteSsoForSession, deleteSsoForUser, deleteExpiredSso } from "./sso-sessions.js";

const SESSION_TTL_DAYS = 30;

export interface Session {
  token: string;
  user_id: string;
  expires_at: string;
  created_at: string;
}

export function createSession(userId: string): Session {
  const token = randomBytes(32).toString("base64url");
  const expiresAt = new Date(
    Date.now() + SESSION_TTL_DAYS * 24 * 60 * 60 * 1000
  ).toISOString();

  db.prepare(
    `INSERT INTO sessions (token, user_id, expires_at) VALUES (?, ?, ?)`
  ).run(token, userId, expiresAt);

  return {
    token,
    user_id: userId,
    expires_at: expiresAt,
    created_at: new Date().toISOString(),
  };
}

export function getSessionUser(token: string): User | undefined {
  const row = db
    .prepare(
      `SELECT u.*
       FROM sessions s
       JOIN users u ON u.id = s.user_id
       WHERE s.token = ? AND s.expires_at > datetime('now')`
    )
    .get(token) as unknown as User | undefined;
  return row;
}

export function deleteSession(token: string): void {
  // The app sign-ins that came out of this session go with it.
  deleteSsoForSession(token);
  db.prepare(`DELETE FROM sessions WHERE token = ?`).run(token);
}

export function deleteAllUserSessions(userId: string): void {
  deleteSsoForUser(userId);
  db.prepare(`DELETE FROM sessions WHERE user_id = ?`).run(userId);
}

export function deleteExpiredSessions(): void {
  deleteExpiredSso();
  db.prepare(`DELETE FROM sessions WHERE expires_at <= datetime('now')`).run();
}
