import { db } from "./index.js";
import { finalizeDetail, type AuditResult } from "../util/audit-detail.js";

export type ActorType = "api-key" | "mcp" | "user-token" | "anonymous";

export interface AuditEntry {
  id: number;
  user_id: string;
  username: string;
  action: string;
  target_user_id: string | null;
  target_username: string | null;
  detail: string | null;
  created_at: string;
  // S12. NULL on rows written before the columns existed = a person using
  // the dashboard.
  actor_type: string | null;
  app_id: string | null;
  result: string | null;
  source_ip: string | null;
  count: number | null;
}

export function logAudit(
  userId: string,
  username: string,
  action: string,
  opts?: {
    targetUserId?: string;
    targetUsername?: string;
    detail?: string;
  }
): void {
  db.prepare(
    `INSERT INTO audit_log (user_id, username, action, target_user_id, target_username, detail)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).run(
    userId,
    username,
    action,
    opts?.targetUserId ?? null,
    opts?.targetUsername ?? null,
    opts?.detail ?? null
  );
}

/**
 * One line for something an API key or the MCP route did. The actor is the
 * app the key belongs to (`api-key:<app id>`): an app key is the only
 * identity the API has, and the id is stable where the name is not. The
 * detail is run through `finalizeDetail`, so even a careless caller cannot
 * store a control character, an over-long string or a token-shaped value.
 */
export function logApiAudit(opts: {
  actorType: ActorType;
  /**
   * Who acted. For an app key the app's id; for a user token the token's id
   * (not the token, not the person: a token is revoked by id, and one person
   * may hold several). Defaults to the app id.
   */
  actorId?: string;
  /** The app acted on; null for calls that are not about one app (list, tokens). */
  appId: string | null;
  action: string;
  result: AuditResult;
  ip: string;
  detail?: string;
}): void {
  const actor = `${opts.actorType}:${opts.actorId ?? opts.appId ?? "none"}`;
  db.prepare(
    `INSERT INTO audit_log
       (user_id, username, action, detail, actor_type, app_id, result, source_ip)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    actor,
    actor,
    opts.action,
    opts.detail ? finalizeDetail(opts.detail) : null,
    opts.actorType,
    opts.appId,
    opts.result,
    opts.ip
  );
}

/** Refused attempts are folded into one row per source, action and window. */
export const DENIED_WINDOW_MINUTES = 10;
/** Distinct sources per action and window before the rest share one row. */
export const DENIED_MAX_ROWS_PER_WINDOW = 100;

/**
 * A refused request (unknown key, missing header, rate limit). Written as a
 * counter, not a line per request: the first refusal from a source opens a
 * row, the next ones inside the window only raise its `count`. A guessing
 * run of a million requests is one row per source, and a flood from more
 * than DENIED_MAX_ROWS_PER_WINDOW sources collapses into a single shared
 * row (`source_ip = '*'`), so the log cannot be filled by refusals. The
 * presented key is never recorded, not even a prefix.
 */
export function logDeniedAudit(opts: {
  actorType: ActorType;
  action: string;
  ip: string;
  reason?: string;
}): void {
  const reason = opts.reason ? finalizeDetail(`reason=${opts.reason}`) : null;
  const window = `-${DENIED_WINDOW_MINUTES} minutes`;
  db.exec("BEGIN IMMEDIATE");
  try {
    const bump = (ip: string): boolean => {
      const row = db
        .prepare(
          `SELECT id FROM audit_log
           WHERE action = ? AND source_ip = ? AND COALESCE(detail, '') = ?
             AND created_at >= datetime('now', ?)
           ORDER BY id DESC LIMIT 1`
        )
        .get(opts.action, ip, reason ?? "", window) as { id: number } | undefined;
      if (!row) return false;
      db.prepare(`UPDATE audit_log SET count = count + 1 WHERE id = ?`).run(row.id);
      return true;
    };
    const insert = (ip: string) =>
      db
        .prepare(
          `INSERT INTO audit_log
             (user_id, username, action, detail, actor_type, result, source_ip)
           VALUES ('anonymous', ?, ?, ?, ?, 'denied', ?)`
        )
        .run(ip, opts.action, reason, opts.actorType, ip);

    if (!bump(opts.ip)) {
      const open = db
        .prepare(
          `SELECT COUNT(*) AS n FROM audit_log
           WHERE action = ? AND source_ip != '*' AND created_at >= datetime('now', ?)`
        )
        .get(opts.action, window) as { n: number };
      if (open.n < DENIED_MAX_ROWS_PER_WINDOW) {
        insert(opts.ip);
      } else if (!bump("*")) {
        insert("*");
      }
    }
    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
}

export type AuditFilter = "all" | "people" | "api" | "denied";

export function getRecentAuditEntries(
  limit = 50,
  filter: AuditFilter = "all"
): AuditEntry[] {
  const where =
    filter === "people"
      ? "WHERE actor_type IS NULL"
      : filter === "api"
        ? "WHERE actor_type IN ('api-key', 'mcp')"
        : filter === "denied"
          ? "WHERE result = 'denied'"
          : "";
  return db
    .prepare(
      `SELECT id, user_id, username, action, target_user_id, target_username, detail,
              created_at, actor_type, app_id, result, source_ip, count
       FROM audit_log ${where} ORDER BY id DESC LIMIT ?`
    )
    .all(limit) as unknown as AuditEntry[];
}

/** How long lines written by the API/MCP route are kept, in days. */
export function apiAuditRetentionDays(): number {
  const n = Number(process.env.AUDIT_API_RETENTION_DAYS);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 90;
}

/** Most API/MCP lines kept, whatever their age. */
export function apiAuditMaxRows(): number {
  const n = Number(process.env.AUDIT_API_MAX_ROWS);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 100_000;
}

/**
 * Keep the API part of the log bounded: drop lines older than the retention
 * and, beyond that, everything past the row cap (oldest first). Lines about
 * people using the dashboard are NOT touched; they are few and are the
 * record of who has rights. Returns how many rows were removed.
 */
export function pruneApiAudit(
  days = apiAuditRetentionDays(),
  maxRows = apiAuditMaxRows()
): number {
  let removed = 0;
  removed += Number(
    db
      .prepare(
        `DELETE FROM audit_log
         WHERE actor_type IS NOT NULL AND created_at < datetime('now', ?)`
      )
      .run(`-${days} days`).changes
  );
  const cutoff = db
    .prepare(
      `SELECT id FROM audit_log WHERE actor_type IS NOT NULL
       ORDER BY id DESC LIMIT 1 OFFSET ?`
    )
    .get(maxRows) as { id: number } | undefined;
  if (cutoff) {
    removed += Number(
      db
        .prepare(`DELETE FROM audit_log WHERE actor_type IS NOT NULL AND id <= ?`)
        .run(cutoff.id).changes
    );
  }
  return removed;
}
