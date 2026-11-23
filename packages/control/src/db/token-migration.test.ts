/**
 * Moving stored tokens to hashes (S10): runs on a database built the OLD way
 * (plaintext keys and tokens), checks that the keys keep working, that a
 * second run changes nothing, and that a crash half-way is repaired.
 */
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { ensureUserTokensTable, migrateTokenStorage } from "./token-migration.js";
import { hashToken, tokenHint } from "../util/token-hash.js";

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
    INSERT INTO apps (id, name, api_key) VALUES ('a1', 'one', 'rwy_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA1111');
    INSERT INTO apps (id, name, api_key) VALUES ('a2', 'two', 'rwy_BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB2222');
    INSERT INTO dev_tokens (id, user_id, token, name) VALUES ('d1', 'u1', 'rwd_CCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC3333', 'laptop');
  `);
  return db;
}

const KEY1 = "rwy_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA1111";
const DEV1 = "rwd_CCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC3333";

describe("migrateTokenStorage on an old database", () => {
  it("stores the hash of the key people already hold, so those keys keep working", () => {
    const db = oldDatabase();
    const result = migrateTokenStorage(db);
    expect(result).toEqual({ appKeys: 2, devTokens: 1 });
    const a1 = db.prepare(`SELECT * FROM apps WHERE id = 'a1'`).get() as any;
    expect(a1.api_key_hash).toBe(hashToken(KEY1));
    expect(a1.api_key_hint).toBe(tokenHint(KEY1));
    const found = db.prepare(`SELECT id FROM apps WHERE api_key_hash = ?`).get(hashToken(KEY1)) as any;
    expect(found.id).toBe("a1");
  });

  it("leaves no plaintext key or token anywhere in the database", () => {
    const db = oldDatabase();
    migrateTokenStorage(db);
    const everything = JSON.stringify([
      db.prepare(`SELECT * FROM apps`).all(),
      db.prepare(`SELECT * FROM dev_tokens`).all(),
    ]);
    expect(everything).not.toContain("rwy_AAAA");
    expect(everything).not.toContain("rwy_BBBB");
    expect(everything).not.toContain("rwd_CCCC");
    expect(everything).toContain("hashed:a1");
  });

  it("keeps the old columns satisfiable: distinct, non-null placeholders", () => {
    const db = oldDatabase();
    migrateTokenStorage(db);
    const keys = (db.prepare(`SELECT api_key FROM apps`).all() as any[]).map((r) => r.api_key);
    expect(new Set(keys).size).toBe(2);
    expect(keys.every((k) => k.startsWith("hashed:"))).toBe(true);
  });

  it("hashes developer tokens, and old ones have no expiry", () => {
    const db = oldDatabase();
    migrateTokenStorage(db);
    const d1 = db.prepare(`SELECT * FROM dev_tokens WHERE id = 'd1'`).get() as any;
    expect(d1.token_hash).toBe(hashToken(DEV1));
    expect(d1.token_hint).toBe("3333");
    expect(d1.expires_at).toBeNull();
  });

  it("is idempotent: a second and third run change nothing", () => {
    const db = oldDatabase();
    migrateTokenStorage(db);
    const before = JSON.stringify(db.prepare(`SELECT * FROM apps ORDER BY id`).all());
    expect(migrateTokenStorage(db)).toEqual({ appKeys: 0, devTokens: 0 });
    expect(migrateTokenStorage(db)).toEqual({ appKeys: 0, devTokens: 0 });
    expect(JSON.stringify(db.prepare(`SELECT * FROM apps ORDER BY id`).all())).toBe(before);
  });

  it("repairs a crash between adding the columns and filling them", () => {
    const db = oldDatabase();
    // The state a crash would leave: columns exist, nothing is filled in.
    db.exec(`ALTER TABLE apps ADD COLUMN api_key_hash TEXT`);
    db.exec(`ALTER TABLE apps ADD COLUMN api_key_hint TEXT`);
    expect(migrateTokenStorage(db).appKeys).toBe(2);
    const a2 = db.prepare(`SELECT api_key_hash FROM apps WHERE id = 'a2'`).get() as any;
    expect(a2.api_key_hash).toBe(hashToken("rwy_BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB2222"));
  });

  it("runs on an empty database and on one with no tokens", () => {
    const db = new DatabaseSync(":memory:");
    db.exec(`
      CREATE TABLE apps (id TEXT PRIMARY KEY, api_key TEXT NOT NULL UNIQUE);
      CREATE TABLE dev_tokens (id TEXT PRIMARY KEY, user_id TEXT, token TEXT NOT NULL UNIQUE, name TEXT);
    `);
    expect(migrateTokenStorage(db)).toEqual({ appKeys: 0, devTokens: 0 });
  });

  it("makes the user_tokens table, also twice", () => {
    const db = oldDatabase();
    ensureUserTokensTable(db);
    ensureUserTokensTable(db);
    const cols = (db.prepare(`PRAGMA table_info(user_tokens)`).all() as any[]).map((c) => c.name);
    expect(cols).toEqual(expect.arrayContaining(["token_hash", "scope", "expires_at", "revoked_at"]));
    expect(cols).not.toContain("token");
  });
});
