/**
 * Storage of the host measurements: one small table of 5-minute buckets and a
 * key/value table for the last known state (container-view flags, last error,
 * totals that rarely change).
 *
 * A bucket holds the running mean of the samples that fell in it, kept in SQL
 * (`value = (value * n + new) / (n + 1)`), so the 5-minute average survives a
 * restart in the middle of a bucket and needs no in-memory accumulator.
 */
import { db } from "../db/index.js";
export { ensureHostTables } from "./schema.js";

export const BUCKET_MS = 5 * 60_000;
export const HOST_RETENTION_DAYS = 60;

export const HOST_KINDS = [
  "cpu_pct", // busy share of the host, 0-100
  "mem_used_bytes",
  "disk_used_bytes",
  "data_images_bytes",
  "data_containers_bytes",
  "data_volumes_bytes",
  "data_buildcache_bytes", // BuildKit cache (+ Docker's own build cache)
] as const;
export type HostKind = (typeof HOST_KINDS)[number];

export function bucketStart(at: number): number {
  return Math.floor(at / BUCKET_MS) * BUCKET_MS;
}

/** Add a sample to its 5-minute bucket (running mean). Non-finite values are ignored. */
export function recordSample(kind: HostKind, value: number, at: number): void {
  if (!Number.isFinite(value)) return;
  db.prepare(
    `INSERT INTO host_metrics (kind, ts, value, n) VALUES (?, ?, ?, 1)
     ON CONFLICT(kind, ts) DO UPDATE SET value = (value * n + excluded.value) / (n + 1), n = n + 1`
  ).run(kind, bucketStart(at), value);
}

export interface Sample {
  ts: number;
  value: number;
}

export function latestSample(kind: HostKind): Sample | null {
  const r = db.prepare(`SELECT ts, value FROM host_metrics WHERE kind = ? ORDER BY ts DESC LIMIT 1`).get(kind) as
    | { ts: number; value: number }
    | undefined;
  return r ? { ts: r.ts, value: r.value } : null;
}

/** The last sample at or before `at`; null when there is none. */
export function sampleAtOrBefore(kind: HostKind, at: number): Sample | null {
  const r = db
    .prepare(`SELECT ts, value FROM host_metrics WHERE kind = ? AND ts <= ? ORDER BY ts DESC LIMIT 1`)
    .get(kind, at) as { ts: number; value: number } | undefined;
  return r ? { ts: r.ts, value: r.value } : null;
}

/** Mean of the buckets in (from, to]; null when the window is empty. */
export function windowAverage(kind: HostKind, from: number, to: number): number | null {
  const r = db
    .prepare(`SELECT AVG(value) AS v, COUNT(*) AS c FROM host_metrics WHERE kind = ? AND ts > ? AND ts <= ?`)
    .get(kind, from, to) as { v: number | null; c: number };
  return r.c > 0 && r.v !== null ? r.v : null;
}

/**
 * `count` consecutive windows of `windowMs`, the last one ending at `now`,
 * each the mean of its buckets (null where nothing was measured). Oldest first.
 */
export function bucketAverages(kind: HostKind, now: number, windowMs: number, count: number): Array<number | null> {
  const start = now - windowMs * count;
  const rows = db
    .prepare(`SELECT ts, value FROM host_metrics WHERE kind = ? AND ts > ? AND ts <= ?`)
    .all(kind, start, now) as unknown as Sample[];
  const sums = new Array<number>(count).fill(0);
  const counts = new Array<number>(count).fill(0);
  for (const r of rows) {
    const i = Math.min(count - 1, Math.floor((r.ts - start) / windowMs));
    if (i < 0) continue;
    sums[i]! += r.value;
    counts[i]!++;
  }
  return sums.map((s, i) => (counts[i]! > 0 ? s / counts[i]! : null));
}

export function getState(key: string): string | null {
  const r = db.prepare(`SELECT value FROM host_state WHERE key = ?`).get(key) as { value: string } | undefined;
  return r ? r.value : null;
}

export function getStateWithTime(key: string): { value: string; updatedAt: number } | null {
  const r = db.prepare(`SELECT value, updated_at FROM host_state WHERE key = ?`).get(key) as
    | { value: string; updated_at: number }
    | undefined;
  return r ? { value: r.value, updatedAt: r.updated_at } : null;
}

export function setState(key: string, value: string, at: number): void {
  db.prepare(
    `INSERT INTO host_state (key, value, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`
  ).run(key, value, at);
}

export function clearState(key: string): void {
  db.prepare(`DELETE FROM host_state WHERE key = ?`).run(key);
}

/** Drop buckets older than the retention. Returns the number removed. Runs hourly. */
export function pruneHostMetrics(now: number = Date.now(), days: number = HOST_RETENTION_DAYS): number {
  const r = db.prepare(`DELETE FROM host_metrics WHERE ts < ?`).run(now - days * 86_400_000);
  return Number(r.changes);
}
