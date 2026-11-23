/**
 * S09: the per-user limit on second-factor guesses. The schedule is pure;
 * the counter lives in the database. Nothing here talks to the network.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { db, migrate } from "../db/index.js";
import { createUser } from "../db/users.js";
import {
  DECAY_MS,
  FREE_ATTEMPTS,
  SEVERE_AT,
  beginAttempt,
  effectiveState,
  lockRemainingSeconds,
  lockSecondsFor,
  lockedUsers,
  pruneAttempts,
  recordSuccess,
  unlock,
  waitText,
} from "./twofa-limit.js";

describe("lockSecondsFor", () => {
  it("allows the first four misses without a lock", () => {
    for (let n = 0; n <= FREE_ATTEMPTS; n++) expect(lockSecondsFor(n)).toBe(0);
  });
  it("locks for 1, 5 and then 15 minutes, and an hour from the 10th", () => {
    expect(lockSecondsFor(5)).toBe(60);
    expect(lockSecondsFor(6)).toBe(5 * 60);
    expect(lockSecondsFor(7)).toBe(15 * 60);
    expect(lockSecondsFor(9)).toBe(15 * 60);
    expect(lockSecondsFor(SEVERE_AT)).toBe(60 * 60);
    expect(lockSecondsFor(500)).toBe(60 * 60);
  });
  it("never shrinks as failures grow", () => {
    let prev = 0;
    for (let n = 1; n < 40; n++) {
      const s = lockSecondsFor(n);
      expect(s).toBeGreaterThanOrEqual(prev);
      prev = s;
    }
  });
});

describe("effectiveState", () => {
  const now = 1_000_000_000_000;
  it("keeps failures that are recent", () => {
    expect(effectiveState({ failures: 3, lockedUntil: 0 }, now - 1000, now).failures).toBe(3);
  });
  it("forgets failures after a day without any", () => {
    expect(effectiveState({ failures: 8, lockedUntil: 0 }, now - DECAY_MS - 1, now).failures).toBe(0);
  });
  it("does not forget while a lock is still running", () => {
    expect(effectiveState({ failures: 8, lockedUntil: now + 5000 }, now - DECAY_MS - 1, now).failures).toBe(8);
  });
  it("starts from zero for a user with no row", () => {
    expect(effectiveState(undefined, 0, now)).toEqual({ failures: 0, lockedUntil: 0 });
  });
});

describe("waitText", () => {
  it("speaks in whole minutes and hours", () => {
    expect(waitText(1)).toBe("1 minute");
    expect(waitText(61)).toBe("2 minutes");
    expect(waitText(3600)).toBe("1 hour");
    expect(waitText(3601)).toBe("2 hours");
  });
});

describe("the counter in the database", () => {
  let userId = "";
  beforeEach(async () => {
    migrate();
    db.exec("DELETE FROM twofa_attempts");
    db.exec("DELETE FROM users");
    userId = (await createUser("dana", "pw-dana-123456", "member")).id;
  });

  it("charges the attempt before the code is checked, and locks on the 5th", () => {
    const t = 1_000_000_000_000;
    for (let i = 1; i <= 4; i++) {
      const r = beginAttempt(userId, t + i);
      expect(r).toMatchObject({ allowed: true, failures: i, lockSeconds: 0 });
    }
    const fifth = beginAttempt(userId, t + 5);
    expect(fifth).toMatchObject({ allowed: true, failures: 5, lockSeconds: 60 });
    const sixth = beginAttempt(userId, t + 6);
    expect(sixth.allowed).toBe(false);
  });

  it("refuses during the lock regardless of what is asked, and allows after it", () => {
    const t = 1_000_000_000_000;
    for (let i = 1; i <= 5; i++) beginAttempt(userId, t);
    const during = beginAttempt(userId, t + 30_000);
    expect(during).toEqual({ allowed: false, retryAfterSeconds: 30 });
    const after = beginAttempt(userId, t + 61_000);
    expect(after).toMatchObject({ allowed: true, failures: 6, lockSeconds: 5 * 60 });
  });

  it("is restart-proof: the state is in the table, not in memory", () => {
    for (let i = 0; i < 5; i++) beginAttempt(userId);
    const row = db.prepare("SELECT failures, locked_until FROM twofa_attempts WHERE user_id = ?").get(userId) as {
      failures: number;
      locked_until: number;
    };
    expect(row.failures).toBe(5);
    expect(row.locked_until).toBeGreaterThan(Date.now());
    expect(lockRemainingSeconds(userId)).toBeGreaterThan(0);
  });

  it("resets on success", () => {
    beginAttempt(userId);
    beginAttempt(userId);
    recordSuccess(userId);
    expect(db.prepare("SELECT COUNT(*) AS n FROM twofa_attempts").get()).toEqual({ n: 0 });
    expect(beginAttempt(userId)).toMatchObject({ failures: 1 });
  });

  it("forgets old failures after a day, so a real user is not punished for ever", () => {
    const t = 1_000_000_000_000;
    for (let i = 0; i < 3; i++) beginAttempt(userId, t);
    const later = beginAttempt(userId, t + DECAY_MS + 1);
    expect(later).toMatchObject({ allowed: true, failures: 1 });
  });

  it("lets an admin lift the lock", () => {
    for (let i = 0; i < 5; i++) beginAttempt(userId);
    expect(lockedUsers().has(userId)).toBe(true);
    expect(unlock(userId)).toBe(true);
    expect(lockedUsers().has(userId)).toBe(false);
    expect(unlock(userId)).toBe(false);
    expect(beginAttempt(userId)).toMatchObject({ allowed: true, failures: 1 });
  });

  it("keeps counters of different users apart", async () => {
    const other = (await createUser("eef", "pw-eef-1234567", "member")).id;
    for (let i = 0; i < 5; i++) beginAttempt(userId);
    expect(beginAttempt(other)).toMatchObject({ allowed: true, failures: 1 });
  });

  it("prunes rows whose failures have decayed", () => {
    const t = 1_000_000_000_000;
    beginAttempt(userId, t);
    pruneAttempts(t + DECAY_MS + 10);
    expect(db.prepare("SELECT COUNT(*) AS n FROM twofa_attempts").get()).toEqual({ n: 0 });
  });
});

describe("migration", () => {
  it("adds the table and the preauth column idempotently, keeping existing rows", async () => {
    migrate();
    const u = await createUser("mig", "pw-mig-1234567", "member");
    db.prepare("INSERT INTO preauth_sessions (token, user_id, expires_at) VALUES ('t1', ?, '2999-01-01')").run(u.id);
    // Put the database back into its pre-S09 shape.
    db.exec("DROP TABLE IF EXISTS twofa_attempts");
    db.exec("ALTER TABLE preauth_sessions DROP COLUMN failures");

    migrate();
    migrate(); // twice: must not throw or duplicate anything

    const cols = (db.prepare("PRAGMA table_info(preauth_sessions)").all() as Array<{ name: string }>).map((c) => c.name);
    expect(cols.filter((n) => n === "failures")).toHaveLength(1);
    const row = db.prepare("SELECT failures FROM preauth_sessions WHERE token = 't1'").get() as { failures: number };
    expect(row.failures).toBe(0);
    expect(db.prepare("SELECT COUNT(*) AS n FROM twofa_attempts").get()).toEqual({ n: 0 });
  });
});
