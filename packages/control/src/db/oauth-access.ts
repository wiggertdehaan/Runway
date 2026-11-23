import { db } from "./index.js";
import type { AccessEntry, AccessKind } from "../auth/oauth-access.js";
import { matchesAccess, emailDomain } from "../auth/oauth-access.js";

/**
 * Who may create an account by signing in with Google or Microsoft.
 * Entries are an address or a whole domain. An "invite" is an address entry
 * that is used up by the first account created with it.
 */
export interface AccessRow extends AccessEntry {
  id: number;
  one_time: number;
  created_by: string | null;
  created_at: string;
}

export function listAccess(): AccessRow[] {
  return db
    .prepare(`SELECT * FROM oauth_access ORDER BY kind DESC, value ASC`)
    .all() as unknown as AccessRow[];
}

export function addAccess(
  entry: AccessEntry,
  opts: { invite?: boolean; createdBy?: string } = {}
): boolean {
  // An invite only makes sense for a single address.
  const oneTime = opts.invite && entry.kind === "email" ? 1 : 0;
  const r = db
    .prepare(
      `INSERT OR IGNORE INTO oauth_access (kind, value, one_time, created_by)
       VALUES (?, ?, ?, ?)`
    )
    .run(entry.kind as AccessKind, entry.value, oneTime, opts.createdBy ?? null);
  return r.changes > 0;
}

export function removeAccess(id: number): boolean {
  return db.prepare(`DELETE FROM oauth_access WHERE id = ?`).run(id).changes > 0;
}

/** Does the allowlist or an open invitation cover this address? */
export function isAccessAllowed(email: string): boolean {
  const e = email.trim().toLowerCase();
  const rows = db
    .prepare(
      `SELECT kind, value FROM oauth_access
        WHERE (kind = 'email' AND value = ?) OR (kind = 'domain' AND value = ?)`
    )
    .all(e, emailDomain(e)) as unknown as AccessEntry[];
  return matchesAccess(rows, e);
}

/** Use up an invitation for this address (no-op for allowlist entries). */
export function consumeInvite(email: string): void {
  db.prepare(
    `DELETE FROM oauth_access WHERE kind = 'email' AND one_time = 1 AND value = ?`
  ).run(email.trim().toLowerCase());
}
