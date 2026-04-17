import type { Context, Next } from "hono";
import { db } from "../db/index.js";

const DEFAULT_MAX_ATTEMPTS = 5;
const DEFAULT_WINDOW_MS = 15 * 60 * 1000;

const API_MAX_REQUESTS = 60;
const API_WINDOW_MS = 60 * 1000;

function ensureTable() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS rate_limits (
      key TEXT PRIMARY KEY,
      count INTEGER NOT NULL DEFAULT 1,
      first_attempt INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    )
  `);
}

let tableReady = false;
function init() {
  if (!tableReady) {
    ensureTable();
    tableReady = true;
  }
}

export function getClientIp(c: Context): string {
  const forwarded = c.req.header("x-forwarded-for");
  if (forwarded) return forwarded.split(",")[0]!.trim();
  return "unknown";
}

function getEntry(key: string, windowMs: number): { count: number; firstAttempt: number } | null {
  init();
  const now = Date.now();
  const row = db
    .prepare(`SELECT count, first_attempt FROM rate_limits WHERE key = ?`)
    .get(key) as { count: number; first_attempt: number } | undefined;

  if (!row) return null;
  if (now - row.first_attempt > windowMs) {
    db.prepare(`DELETE FROM rate_limits WHERE key = ?`).run(key);
    return null;
  }
  return { count: row.count, firstAttempt: row.first_attempt };
}

export function isRateLimited(
  ip: string,
  maxAttempts = DEFAULT_MAX_ATTEMPTS,
  windowMs = DEFAULT_WINDOW_MS
): boolean {
  const entry = getEntry(`login:${ip}`, windowMs);
  if (!entry) return false;
  return entry.count >= maxAttempts;
}

export function recordFailedAttempt(
  ip: string,
  windowMs = DEFAULT_WINDOW_MS
): void {
  init();
  const now = Date.now();
  const key = `login:${ip}`;
  const entry = getEntry(key, windowMs);

  if (!entry) {
    db.prepare(
      `INSERT OR REPLACE INTO rate_limits (key, count, first_attempt, updated_at)
       VALUES (?, 1, ?, ?)`
    ).run(key, now, now);
  } else {
    db.prepare(
      `UPDATE rate_limits SET count = count + 1, updated_at = ? WHERE key = ?`
    ).run(now, key);
  }
}

export function clearAttempts(ip: string): void {
  init();
  db.prepare(`DELETE FROM rate_limits WHERE key = ?`).run(`login:${ip}`);
}

export function remainingLockoutSeconds(
  ip: string,
  windowMs = DEFAULT_WINDOW_MS
): number {
  const entry = getEntry(`login:${ip}`, windowMs);
  if (!entry) return 0;
  const elapsed = Date.now() - entry.firstAttempt;
  if (elapsed > windowMs) return 0;
  return Math.ceil((windowMs - elapsed) / 1000);
}

export async function apiRateLimit(c: Context, next: Next) {
  if (!c.req.path.startsWith("/api/")) {
    return next();
  }

  init();
  const ip = getClientIp(c);
  const key = `api:${ip}`;
  const now = Date.now();
  const entry = getEntry(key, API_WINDOW_MS);

  if (entry && entry.count >= API_MAX_REQUESTS) {
    return c.json({ error: "Rate limit exceeded. Try again later." }, 429);
  }

  if (!entry) {
    db.prepare(
      `INSERT OR REPLACE INTO rate_limits (key, count, first_attempt, updated_at)
       VALUES (?, 1, ?, ?)`
    ).run(key, now, now);
  } else {
    db.prepare(
      `UPDATE rate_limits SET count = count + 1, updated_at = ? WHERE key = ?`
    ).run(now, key);
  }

  await next();
}

export function cleanupExpiredEntries(): void {
  init();
  const cutoff = Date.now() - DEFAULT_WINDOW_MS;
  db.prepare(`DELETE FROM rate_limits WHERE first_attempt < ?`).run(cutoff);
}
