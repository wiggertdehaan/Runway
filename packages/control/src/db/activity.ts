import { db } from "./index.js";

export interface BucketRow {
  app_id: string;
  hour_at: string;
  count: number;
}

/**
 * Round a Date to the start of its UTC hour. The bucket key format
 * matches what SQLite would produce with strftime('%Y-%m-%dT%H:00:00Z').
 */
export function hourKey(date: Date): string {
  const iso = date.toISOString(); // e.g. 2026-05-04T13:42:17.123Z
  return `${iso.slice(0, 13)}:00:00Z`;
}

/**
 * Record one request against an app. Bumps the current hour's bucket
 * and updates the app's last_request_at if the new timestamp is more
 * recent. Called per-line by the access log tailer.
 */
export function bumpRequest(appId: string, when: Date): void {
  const bucket = hourKey(when);
  const iso = when.toISOString();
  db.prepare(
    `INSERT INTO app_request_buckets (app_id, hour_at, count)
     VALUES (?, ?, 1)
     ON CONFLICT(app_id, hour_at) DO UPDATE SET count = count + 1`
  ).run(appId, bucket);
  db.prepare(
    `UPDATE apps
     SET last_request_at = ?
     WHERE id = ?
       AND (last_request_at IS NULL OR last_request_at < ?)`
  ).run(iso, appId, iso);
}

/**
 * Fetch hourly buckets per app for the last `hours` hours, ending at
 * the current hour. Returns a Map<app_id, number[]> with exactly
 * `hours` entries per app, oldest first. Apps with no traffic in the
 * window get an array of zeros so the caller can render uniformly.
 */
export function getBucketsBulk(
  appIds: string[],
  hours: number
): Map<string, number[]> {
  const result = new Map<string, number[]>();
  if (appIds.length === 0) return result;

  const now = new Date();
  const currentHour = new Date(
    Date.UTC(
      now.getUTCFullYear(),
      now.getUTCMonth(),
      now.getUTCDate(),
      now.getUTCHours()
    )
  );
  // Build the array of hour keys oldest → newest so we can index by
  // bucket key in O(1).
  const hourKeys: string[] = [];
  const hourIndex = new Map<string, number>();
  for (let i = hours - 1; i >= 0; i--) {
    const d = new Date(currentHour.getTime() - i * 60 * 60 * 1000);
    const key = hourKey(d);
    hourIndex.set(key, hours - 1 - i);
    hourKeys.push(key);
  }

  for (const id of appIds) {
    result.set(id, new Array(hours).fill(0));
  }

  const oldest = hourKeys[0];
  const placeholders = appIds.map(() => "?").join(",");
  const rows = db
    .prepare(
      `SELECT app_id, hour_at, count
       FROM app_request_buckets
       WHERE hour_at >= ?
         AND app_id IN (${placeholders})`
    )
    .all(oldest, ...appIds) as unknown as BucketRow[];

  for (const row of rows) {
    const idx = hourIndex.get(row.hour_at);
    if (idx === undefined) continue;
    const arr = result.get(row.app_id);
    if (arr) arr[idx] = row.count;
  }
  return result;
}

/**
 * Drop buckets older than the retention window. Called periodically
 * by the tailer so the table doesn't grow without bound.
 */
export function pruneOldBuckets(keepHours: number): number {
  const cutoff = new Date(Date.now() - keepHours * 60 * 60 * 1000);
  const result = db
    .prepare(`DELETE FROM app_request_buckets WHERE hour_at < ?`)
    .run(hourKey(cutoff));
  return Number(result.changes ?? 0);
}
