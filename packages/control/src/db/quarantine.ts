import { db } from "./index.js";

export type QuarantineState = "grace" | "quarantined";

export interface QuarantineRow {
  app_id: string;
  state: QuarantineState;
  /** KEV CVE id -> ISO time it was first seen on this app. */
  kev_first_seen: Record<string, string>;
  /** ISO time of the final rebuild attempt made at the deadline. */
  attempt_at: string | null;
  quarantined_at: string | null;
  updated_at: string;
}

interface Raw {
  app_id: string;
  state: string;
  kev_first_seen: string;
  attempt_at: string | null;
  quarantined_at: string | null;
  updated_at: string;
}

function toRow(r: Raw): QuarantineRow {
  let seen: Record<string, string> = {};
  try {
    seen = JSON.parse(r.kev_first_seen) as Record<string, string>;
  } catch {
    /* corrupt: treat as just-detected rather than crash the tick */
  }
  return {
    app_id: r.app_id,
    state: r.state as QuarantineState,
    kev_first_seen: seen,
    attempt_at: r.attempt_at,
    quarantined_at: r.quarantined_at,
    updated_at: r.updated_at,
  };
}

export function getQuarantine(appId: string): QuarantineRow | undefined {
  const r = db.prepare(`SELECT * FROM app_quarantine WHERE app_id = ?`).get(appId) as
    | unknown as Raw
    | undefined;
  return r ? toRow(r) : undefined;
}

export function listQuarantine(): QuarantineRow[] {
  return (
    db.prepare(`SELECT * FROM app_quarantine ORDER BY updated_at DESC`).all() as unknown as Raw[]
  ).map(toRow);
}

export function saveQuarantine(row: Omit<QuarantineRow, "updated_at">): void {
  db.prepare(
    `INSERT INTO app_quarantine (app_id, state, kev_first_seen, attempt_at, quarantined_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(app_id) DO UPDATE SET
       state = excluded.state,
       kev_first_seen = excluded.kev_first_seen,
       attempt_at = excluded.attempt_at,
       quarantined_at = excluded.quarantined_at,
       updated_at = excluded.updated_at`
  ).run(
    row.app_id,
    row.state,
    JSON.stringify(row.kev_first_seen),
    row.attempt_at,
    row.quarantined_at,
    new Date().toISOString()
  );
}

export function deleteQuarantine(appId: string): void {
  db.prepare(`DELETE FROM app_quarantine WHERE app_id = ?`).run(appId);
}

// ── Exemptions ───────────────────────────────────────────────────

export interface QuarantineExemption {
  app_id: string;
  reason: string;
  /** ISO time the exemption ends. */
  until: string;
  granted_by: string;
  created_at: string;
}

export function getExemption(appId: string): QuarantineExemption | undefined {
  return db
    .prepare(`SELECT * FROM quarantine_exemptions WHERE app_id = ?`)
    .get(appId) as unknown as QuarantineExemption | undefined;
}

/** The exemption, only if it has not expired yet. */
export function getActiveExemption(
  appId: string,
  now: Date = new Date()
): QuarantineExemption | undefined {
  const e = getExemption(appId);
  if (!e) return undefined;
  const until = Date.parse(e.until);
  return Number.isFinite(until) && until > now.getTime() ? e : undefined;
}

export function setExemption(e: Omit<QuarantineExemption, "created_at">): void {
  db.prepare(
    `INSERT INTO quarantine_exemptions (app_id, reason, until, granted_by, created_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(app_id) DO UPDATE SET
       reason = excluded.reason,
       until = excluded.until,
       granted_by = excluded.granted_by,
       created_at = excluded.created_at`
  ).run(e.app_id, e.reason, e.until, e.granted_by, new Date().toISOString());
}

export function deleteExemption(appId: string): void {
  db.prepare(`DELETE FROM quarantine_exemptions WHERE app_id = ?`).run(appId);
}

// ── Notices (owner-visible messages on the app page) ─────────────

export interface AppNotice {
  id: number;
  app_id: string;
  kind: string;
  message: string;
  created_at: string;
}

/**
 * Add a notice. With `dedupeDays`, an identical (kind, message) already
 * recorded within that window is not added again (a weekly rebuild that
 * keeps finding the same "major 25 resolves X" must not spam).
 * Returns true if a new notice was stored.
 */
export function addNotice(
  appId: string,
  kind: string,
  message: string,
  dedupeDays?: number
): boolean {
  if (dedupeDays !== undefined) {
    const dup = db
      .prepare(
        `SELECT 1 FROM app_notices
         WHERE app_id = ? AND kind = ? AND message = ?
           AND created_at >= datetime('now', ?) LIMIT 1`
      )
      .get(appId, kind, message, `-${dedupeDays} days`);
    if (dup) return false;
  }
  db.prepare(`INSERT INTO app_notices (app_id, kind, message) VALUES (?, ?, ?)`).run(
    appId,
    kind,
    message
  );
  return true;
}

export function listNotices(appId: string, limit = 10): AppNotice[] {
  return db
    .prepare(`SELECT * FROM app_notices WHERE app_id = ? ORDER BY id DESC LIMIT ?`)
    .all(appId, limit) as unknown as AppNotice[];
}
