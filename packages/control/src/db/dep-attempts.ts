import { db } from "./index.js";

/** How long a failed dependency update is left alone before a retry. */
export const DEP_RETRY_DAYS = 14;

export type DepAttemptOutcome = "applied" | "blocked" | "unhealthy" | "failed";

/** Record the outcome of raising one dependency (dep_key = depKey()). */
export function recordDepAttempt(
  appId: string,
  depKey: string,
  outcome: DepAttemptOutcome,
  detail?: string
): void {
  db.prepare(
    `INSERT INTO dep_update_attempts (app_id, dep_key, outcome, detail) VALUES (?, ?, ?, ?)`
  ).run(appId, depKey, outcome, detail ? detail.slice(0, 500) : null);
  // Keep the table small: the newest 200 rows per app are plenty.
  db.prepare(
    `DELETE FROM dep_update_attempts
     WHERE app_id = ? AND id NOT IN (
       SELECT id FROM dep_update_attempts WHERE app_id = ? ORDER BY id DESC LIMIT 200
     )`
  ).run(appId, appId);
}

/**
 * dep_keys whose most recent attempt for this app failed within the
 * retry window. A later success for the same key clears it.
 */
export function recentDepFailures(appId: string, days = DEP_RETRY_DAYS): Set<string> {
  const rows = db
    .prepare(
      `SELECT a.dep_key, a.outcome FROM dep_update_attempts a
       WHERE a.app_id = ?
         AND a.id = (SELECT MAX(b.id) FROM dep_update_attempts b
                     WHERE b.app_id = a.app_id AND b.dep_key = a.dep_key)
         AND a.created_at >= datetime('now', ?)`
    )
    .all(appId, `-${days} days`) as unknown as Array<{ dep_key: string; outcome: string }>;
  return new Set(rows.filter((r) => r.outcome !== "applied").map((r) => r.dep_key));
}
