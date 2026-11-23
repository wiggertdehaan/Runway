import { db } from "../db/index.js";

/**
 * S09: a limit on guesses at the second factor, per user.
 *
 * Before this, 2FA failures shared one per-IP counter with the password
 * step, and a correct password wiped it. Someone who knew the password could
 * make four guesses, sign in again to reset the counter, and keep going.
 *
 * Now every guess (authenticator code or backup code) is charged to the
 * USER, in the database, before the code is checked:
 *
 *  - the counter is not reset by a correct password, only by a correct
 *    second factor, an admin unlock, or 24 hours without a failure;
 *  - it survives a restart;
 *  - it is raised before the check, so parallel requests cannot all slip
 *    through on the same low count: SQLite runs this synchronously, so the
 *    request that crosses the threshold sets the lock before the next one
 *    reads it.
 *
 * Schedule (failures since the last success): the 5th wrong code locks for
 * 1 minute, the 6th for 5 minutes, the 7th to 9th for 15 minutes, and from
 * the 10th an hour per try (and an administrator is alerted). At 6 digits
 * with a ±1 step window, an hour per try makes guessing hopeless, while a
 * real user who fat-fingers a code is back in a minute.
 */

/** Wrong codes allowed before the first lock (the next miss locks). */
export const FREE_ATTEMPTS = 4;
/** The failure number from which an administrator is alerted. */
export const SEVERE_AT = 10;
/** A failure this old no longer counts: a real user is not punished for ever. */
export const DECAY_MS = 24 * 60 * 60 * 1000;
/** Failures on one pre-auth session before it is destroyed. */
export const MAX_FAILURES_PER_PREAUTH = 5;

/** How long to lock after the Nth consecutive failure. Pure. */
export function lockSecondsFor(failures: number): number {
  if (failures <= FREE_ATTEMPTS) return 0;
  const step = failures - FREE_ATTEMPTS; // 1, 2, 3, ...
  if (step === 1) return 60;
  if (step === 2) return 5 * 60;
  if (step <= 5) return 15 * 60;
  return 60 * 60;
}

export interface AttemptState {
  failures: number;
  lockedUntil: number;
}

/** Pure: the state before a new attempt, after applying the decay. */
export function effectiveState(row: AttemptState | undefined, lastFailureAt: number, now: number): AttemptState {
  if (!row) return { failures: 0, lockedUntil: 0 };
  if (row.lockedUntil <= now && now - lastFailureAt > DECAY_MS) {
    return { failures: 0, lockedUntil: 0 };
  }
  return row;
}

export type Begin =
  | { allowed: true; failures: number; lockSeconds: number }
  | { allowed: false; retryAfterSeconds: number };

interface Row {
  failures: number;
  last_failure_at: number;
  locked_until: number;
}

function readRow(userId: string): Row | undefined {
  return db
    .prepare(`SELECT failures, last_failure_at, locked_until FROM twofa_attempts WHERE user_id = ?`)
    .get(userId) as Row | undefined;
}

/**
 * Ask permission for ONE guess, and charge it. Call this before looking at
 * the code. If it says allowed, the attempt is already counted; call
 * recordSuccess() when the code turns out to be right.
 *
 * While a lock runs the answer does not depend on the code at all, so a
 * correct code during a lock is refused exactly like a wrong one.
 */
export function beginAttempt(userId: string, now = Date.now()): Begin {
  db.exec("BEGIN IMMEDIATE");
  try {
    const row = readRow(userId);
    if (row && row.locked_until > now) {
      db.exec("COMMIT");
      return { allowed: false, retryAfterSeconds: Math.ceil((row.locked_until - now) / 1000) };
    }
    const state = effectiveState(
      row ? { failures: row.failures, lockedUntil: row.locked_until } : undefined,
      row?.last_failure_at ?? 0,
      now
    );
    const failures = state.failures + 1;
    const lockSeconds = lockSecondsFor(failures);
    db.prepare(
      `INSERT INTO twofa_attempts (user_id, failures, last_failure_at, locked_until)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(user_id) DO UPDATE SET
         failures = excluded.failures,
         last_failure_at = excluded.last_failure_at,
         locked_until = excluded.locked_until`
    ).run(userId, failures, now, lockSeconds ? now + lockSeconds * 1000 : 0);
    db.exec("COMMIT");
    return { allowed: true, failures, lockSeconds };
  } catch (err) {
    try {
      db.exec("ROLLBACK");
    } catch {
      /* already rolled back */
    }
    throw err;
  }
}

/** A correct second factor: forget the failures. */
export function recordSuccess(userId: string): void {
  db.prepare(`DELETE FROM twofa_attempts WHERE user_id = ?`).run(userId);
}

/** An administrator lifts the lock. Returns true when there was one. */
export function unlock(userId: string): boolean {
  const row = readRow(userId);
  if (!row) return false;
  db.prepare(`DELETE FROM twofa_attempts WHERE user_id = ?`).run(userId);
  return row.locked_until > Date.now() || row.failures > 0;
}

/** Seconds left on the lock, 0 when not locked. */
export function lockRemainingSeconds(userId: string, now = Date.now()): number {
  const row = readRow(userId);
  if (!row || row.locked_until <= now) return 0;
  return Math.ceil((row.locked_until - now) / 1000);
}

/** Everyone who is locked right now, for the admin's Users page. */
export function lockedUsers(now = Date.now()): Map<string, number> {
  const rows = db
    .prepare(`SELECT user_id, locked_until FROM twofa_attempts WHERE locked_until > ?`)
    .all(now) as unknown as Array<{ user_id: string; locked_until: number }>;
  return new Map(rows.map((r) => [r.user_id, r.locked_until]));
}

/** Housekeeping: drop rows whose failures have decayed and whose lock is over. */
export function pruneAttempts(now = Date.now()): void {
  db.prepare(`DELETE FROM twofa_attempts WHERE locked_until <= ? AND last_failure_at < ?`).run(
    now,
    now - DECAY_MS
  );
}

/** "1 minute", "5 minutes", "1 hour": friendly text for the login page. */
export function waitText(seconds: number): string {
  const minutes = Math.max(1, Math.ceil(seconds / 60));
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? "" : "s"}`;
  const hours = Math.ceil(minutes / 60);
  return `${hours} hour${hours === 1 ? "" : "s"}`;
}
