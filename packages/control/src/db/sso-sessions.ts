/**
 * S02: the sign-in of an app host, kept apart from the dashboard session.
 *
 * A visitor of an SSO app proves who they are on the dashboard (host-only
 * cookie), which hands them a one-time ticket bound to ONE app host. The app
 * host swaps the ticket for its own cookie, valid for that host only. Nothing
 * here can be used on the dashboard, and the dashboard cookie never reaches an
 * app. Tokens are random 32 bytes and stored as SHA-256, so a copy of the
 * database does not yield usable cookies.
 *
 * Both tables hang off the dashboard session they came from: when it is
 * signed out, expired or the user is deleted, the app sign-ins go with it.
 */
import { createHash, randomBytes } from "node:crypto";
import { db } from "./index.js";

const TICKET_TTL_MS = 60 * 1000;
export const SSO_SESSION_TTL_MS = 8 * 60 * 60 * 1000;

export function hashToken(raw: string): string {
  return createHash("sha256").update(raw).digest("hex");
}

function newToken(): string {
  return randomBytes(32).toString("base64url");
}

export interface SsoGrant {
  appId: string;
  userId: string;
}

/** A one-time ticket for `host`, issued from the given dashboard session. */
export function createSsoTicket(input: {
  host: string;
  appId: string;
  userId: string;
  dashboardToken: string;
  now?: number;
}): string {
  const raw = newToken();
  const now = input.now ?? Date.now();
  db.prepare(
    `INSERT INTO sso_tickets (hash, host, app_id, user_id, parent_token, expires_at)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).run(hashToken(raw), input.host, input.appId, input.userId, input.dashboardToken, now + TICKET_TTL_MS);
  return raw;
}

/**
 * Spend a ticket. Single use (the row is deleted in the same statement that
 * reads it), bound to the host it was issued for, short-lived, and only while
 * the dashboard session it came from is still alive.
 */
export function redeemSsoTicket(
  raw: string,
  host: string,
  now: number = Date.now()
): (SsoGrant & { parentToken: string }) | undefined {
  const row = db
    .prepare(
      `DELETE FROM sso_tickets WHERE hash = ? AND host = ? AND expires_at > ?
       RETURNING app_id, user_id, parent_token`
    )
    .get(hashToken(raw), host, now) as
    | { app_id: string; user_id: string; parent_token: string }
    | undefined;
  if (!row) return undefined;
  const alive = db
    .prepare(`SELECT 1 AS ok FROM sessions WHERE token = ? AND user_id = ? AND expires_at > datetime('now')`)
    .get(row.parent_token, row.user_id);
  if (!alive) return undefined;
  return { appId: row.app_id, userId: row.user_id, parentToken: row.parent_token };
}

export function createSsoSession(input: {
  host: string;
  appId: string;
  userId: string;
  parentToken: string;
  now?: number;
}): string {
  const raw = newToken();
  const now = input.now ?? Date.now();
  db.prepare(
    `INSERT INTO sso_sessions (hash, host, app_id, user_id, parent_token, expires_at)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).run(hashToken(raw), input.host, input.appId, input.userId, input.parentToken, now + SSO_SESSION_TTL_MS);
  return raw;
}

/** The grant behind an app-host cookie, only for the host it was issued to and while its dashboard session lives. */
export function getSsoSession(
  raw: string,
  host: string,
  now: number = Date.now()
): SsoGrant | undefined {
  const row = db
    .prepare(
      `SELECT s.app_id, s.user_id
         FROM sso_sessions s
         JOIN sessions p ON p.token = s.parent_token AND p.expires_at > datetime('now')
        WHERE s.hash = ? AND s.host = ? AND s.expires_at > ?`
    )
    .get(hashToken(raw), host, now) as { app_id: string; user_id: string } | undefined;
  return row ? { appId: row.app_id, userId: row.user_id } : undefined;
}

export function deleteSsoForSession(dashboardToken: string): void {
  db.prepare(`DELETE FROM sso_sessions WHERE parent_token = ?`).run(dashboardToken);
  db.prepare(`DELETE FROM sso_tickets WHERE parent_token = ?`).run(dashboardToken);
}

export function deleteSsoForUser(userId: string): void {
  db.prepare(`DELETE FROM sso_sessions WHERE user_id = ?`).run(userId);
  db.prepare(`DELETE FROM sso_tickets WHERE user_id = ?`).run(userId);
}

export function deleteSsoForApp(appId: string): void {
  db.prepare(`DELETE FROM sso_sessions WHERE app_id = ?`).run(appId);
  db.prepare(`DELETE FROM sso_tickets WHERE app_id = ?`).run(appId);
}

export function deleteExpiredSso(now: number = Date.now()): void {
  db.prepare(`DELETE FROM sso_sessions WHERE expires_at <= ?`).run(now);
  db.prepare(`DELETE FROM sso_tickets WHERE expires_at <= ?`).run(now);
}
