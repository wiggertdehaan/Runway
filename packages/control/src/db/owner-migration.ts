import type { DatabaseSync } from "node:sqlite";

/**
 * App ownership by user id (S13).
 *
 * Until now an app belonged to a username string (`apps.created_by`) and
 * every rights check compared that string with the signed-in user's name.
 * Delete a user and let a new account (an OAuth login takes its name from the
 * email prefix) pick the same name, and the newcomer owned every app of the
 * previous person, env secrets included.
 *
 * Ownership is now `apps.owner_user_id`. This file holds the one-time step
 * that fills it for existing apps. It runs exactly once, in the same
 * transaction that adds the column, and never again: re-running it later
 * would link an app that was deliberately left ownerless (user deleted) to
 * whoever has taken that name since, which is the hole itself.
 *
 * `created_by` stays in place. Nothing reads it for rights any more; it is
 * the historical label, and it keeps a rollback to the previous release
 * working (that release still reads it).
 */

export interface UserRef {
  id: string;
  username: string;
}

/** The app owners we could not tie to a user, reported to the administrator. */
export interface UnlinkedOwner {
  appId: string;
  appName: string | null;
  formerOwner: string;
}

export interface OwnerBackfillResult {
  /** Apps now tied to a user id. */
  linked: number;
  /** Apps that already had no owner (rows from before v0.3). They stay admin-only. */
  withoutOwner: number;
  /** Apps whose owner name matched no single user; now ownerless and admin-only. */
  unlinked: UnlinkedOwner[];
}

/**
 * Which user does an old owner name stand for? Only an exact, single match
 * counts. The old check was a strict string comparison, so "Alice" never
 * matched an account "alice" and still does not. No match, or more than one,
 * means no owner: an app must not silently belong to a guess.
 */
export function resolveOwner(
  createdBy: string | null,
  users: readonly UserRef[]
): UserRef | null {
  if (!createdBy) return null;
  const matches = users.filter((u) => u.username === createdBy);
  return matches.length === 1 ? matches[0]! : null;
}

/**
 * Fill owner_user_id from created_by. Call only right after the column was
 * added (see migrate()). Reports what it could not link: one console warning
 * and one audit line, so the administrator sees it.
 */
export function backfillOwnerUserIds(db: DatabaseSync): OwnerBackfillResult {
  const users = db
    .prepare(`SELECT id, username FROM users`)
    .all() as unknown as UserRef[];
  const apps = db
    .prepare(`SELECT id, name, created_by FROM apps WHERE owner_user_id IS NULL`)
    .all() as unknown as Array<{ id: string; name: string | null; created_by: string | null }>;

  const set = db.prepare(`UPDATE apps SET owner_user_id = ? WHERE id = ?`);
  const result: OwnerBackfillResult = { linked: 0, withoutOwner: 0, unlinked: [] };

  for (const a of apps) {
    if (!a.created_by) {
      result.withoutOwner++;
      continue;
    }
    const owner = resolveOwner(a.created_by, users);
    if (owner) {
      set.run(owner.id, a.id);
      result.linked++;
    } else {
      result.unlinked.push({ appId: a.id, appName: a.name, formerOwner: a.created_by });
    }
  }

  if (result.unlinked.length > 0) {
    const detail = result.unlinked
      .map((u) => `${u.appId}${u.appName ? ` (${u.appName})` : ""} was owned by "${u.formerOwner}"`)
      .join("; ");
    console.warn(
      `[runway] ${result.unlinked.length} app(s) belonged to a username that matches no account and are now without an owner (admin-only): ${detail}.`
    );
    db.prepare(
      `INSERT INTO audit_log (user_id, username, action, detail)
       VALUES ('system', 'system', 'app_owner_unlinked', ?)`
    ).run(detail);
  }
  return result;
}
