/**
 * Developer tokens (rwd_) made before tokens expired never expire. The upgrade
 * gives each of them an expiry 90 days out, once, without touching a date that
 * already exists, and without breaking the token before that day.
 */
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import {
  LEGACY_DEV_TOKEN_DAYS,
  expireLegacyDevTokens,
  migrateTokenStorage,
} from "./token-migration.js";
import { hashToken } from "../util/token-hash.js";

const DAY = 86_400_000;
const NOW = Date.parse("2026-11-23T10:00:00Z");
const T = (ms: number) => new Date(ms).toISOString().slice(0, 19).replace("T", " ");

/** A database as an older release left it: dev_tokens has no expiry column at all. */
function oldDatabase(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  db.exec(`
    CREATE TABLE users (id TEXT PRIMARY KEY, username TEXT, role TEXT);
    CREATE TABLE apps (
      id TEXT PRIMARY KEY, name TEXT, api_key TEXT NOT NULL UNIQUE,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE dev_tokens (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      token TEXT NOT NULL UNIQUE, name TEXT NOT NULL, last_used_at TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    INSERT INTO users (id, username, role) VALUES ('u1', 'alice', 'member');
    INSERT INTO dev_tokens (id, user_id, token, name) VALUES ('d1', 'u1', 'rwd_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA1111', 'laptop');
    INSERT INTO dev_tokens (id, user_id, token, name) VALUES ('d2', 'u1', 'rwd_BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB2222', 'ci');
  `);
  return db;
}

const rows = (db: DatabaseSync) =>
  db.prepare(`SELECT id, expires_at, expiry_assigned FROM dev_tokens ORDER BY id`).all() as Array<{
    id: string;
    expires_at: string | null;
    expiry_assigned: number;
  }>;

describe("expireLegacyDevTokens on an old database", () => {
  it("gives every token without an expiry a date 90 days out, and marks it", () => {
    const db = oldDatabase();
    migrateTokenStorage(db);
    const none = db.prepare(`SELECT expires_at FROM dev_tokens`).all() as Array<{ expires_at: string | null }>;
    expect(none.every((r) => r.expires_at === null)).toBe(true);
    expect(expireLegacyDevTokens(db, NOW)).toBe(2);
    for (const r of rows(db)) {
      expect(r.expires_at).toBe(T(NOW + LEGACY_DEV_TOKEN_DAYS * DAY));
      expect(r.expiry_assigned).toBe(1);
    }
    expect(LEGACY_DEV_TOKEN_DAYS).toBe(90);
  });

  it("is idempotent: a second and a third run change nothing", () => {
    const db = oldDatabase();
    migrateTokenStorage(db);
    expireLegacyDevTokens(db, NOW);
    const before = rows(db);
    expect(expireLegacyDevTokens(db, NOW + 30 * DAY)).toBe(0);
    expect(expireLegacyDevTokens(db, NOW + 60 * DAY)).toBe(0);
    expect(rows(db)).toEqual(before);
  });

  it("never touches a date that exists: earlier stays earlier, later stays later", () => {
    const db = oldDatabase();
    migrateTokenStorage(db);
    db.prepare(`UPDATE dev_tokens SET expires_at = ? WHERE id = 'd1'`).run(T(NOW + 10 * DAY));
    db.prepare(`UPDATE dev_tokens SET expires_at = ? WHERE id = 'd2'`).run(T(NOW + 300 * DAY));
    db.exec(`INSERT INTO dev_tokens (id, user_id, token, name) VALUES ('d3', 'u1', 'rwd_CCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC3333', 'old')`);
    migrateTokenStorage(db);
    expect(expireLegacyDevTokens(db, NOW)).toBe(1);
    const byId = Object.fromEntries(rows(db).map((r) => [r.id, r]));
    expect(byId["d1"]).toMatchObject({ expires_at: T(NOW + 10 * DAY), expiry_assigned: 0 });
    expect(byId["d2"]).toMatchObject({ expires_at: T(NOW + 300 * DAY), expiry_assigned: 0 });
    expect(byId["d3"]).toMatchObject({ expires_at: T(NOW + 90 * DAY), expiry_assigned: 1 });
  });

  it("a token that expired already is left as it is (not revived)", () => {
    const db = oldDatabase();
    migrateTokenStorage(db);
    db.prepare(`UPDATE dev_tokens SET expires_at = ? WHERE id = 'd1'`).run(T(NOW - 5 * DAY));
    expireLegacyDevTokens(db, NOW);
    const d1 = rows(db).find((r) => r.id === "d1")!;
    expect(d1.expires_at).toBe(T(NOW - 5 * DAY));
    expect(d1.expiry_assigned).toBe(0);
  });

  it("the token people already hold still matches until the new date", () => {
    const db = oldDatabase();
    migrateTokenStorage(db);
    expireLegacyDevTokens(db, NOW);
    const row = db
      .prepare(`SELECT expires_at FROM dev_tokens WHERE token_hash = ?`)
      .get(hashToken("rwd_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA1111")) as { expires_at: string };
    expect(row).toBeDefined();
    const ms = Date.parse(row.expires_at.replace(" ", "T") + "Z");
    expect(ms).toBeGreaterThan(NOW + 89 * DAY);
  });

  it("works when the column is already there (a crash half-way is repaired by the next start)", () => {
    const db = oldDatabase();
    migrateTokenStorage(db);
    db.exec(`ALTER TABLE dev_tokens ADD COLUMN expiry_assigned INTEGER NOT NULL DEFAULT 0`);
    expect(expireLegacyDevTokens(db, NOW)).toBe(2);
  });
});
