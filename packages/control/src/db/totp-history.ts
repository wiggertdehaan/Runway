import { db } from "./index.js";
import { verifyTotp } from "../auth/totp.js";

// TOTP drift window is ±1 step of 30s each. Counters older than
// ~5 minutes cannot be replayed against the current time, so rows
// beyond that age are safe to discard.
const HISTORY_RETENTION_SECONDS = 5 * 60;

/**
 * Atomically claim a TOTP counter for a user. Returns true if the
 * counter was successfully inserted (fresh use), false if the same
 * counter was already recorded for that user (replay).
 *
 * Thanks to the composite primary key on (user_id, counter), SQLite
 * rejects the duplicate at INSERT time — we catch the constraint
 * violation and translate it into a boolean without racing.
 */
export function claimTotpCounter(userId: string, counter: number): boolean {
  try {
    db.prepare(
      `INSERT INTO used_totp_counters (user_id, counter) VALUES (?, ?)`
    ).run(userId, counter);
  } catch (err: any) {
    if (/UNIQUE|constraint/i.test(String(err?.message ?? ""))) {
      return false;
    }
    throw err;
  }
  pruneExpiredTotpCounters();
  return true;
}

function pruneExpiredTotpCounters(): void {
  db.prepare(
    `DELETE FROM used_totp_counters
     WHERE used_at <= datetime('now', ?)`
  ).run(`-${HISTORY_RETENTION_SECONDS} seconds`);
}

/**
 * Verify a TOTP code AND atomically claim the underlying counter so
 * the same code cannot produce two sessions. Replaces the bare
 * `verifyTotp()` at every call site that authenticates a user.
 */
export function verifyAndConsumeTotp(
  userId: string,
  secret: string,
  code: string
): boolean {
  const counter = verifyTotp(secret, code);
  if (counter === null) return false;
  return claimTotpCounter(userId, counter);
}
