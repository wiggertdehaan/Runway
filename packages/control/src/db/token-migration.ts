import type { DatabaseSync } from "node:sqlite";
import { hashToken, isPlaceholder, placeholderFor, tokenHint } from "../util/token-hash.js";

/**
 * Tokens stored as hashes (S10, S11, S18).
 *
 * Until now the app API keys (`apps.api_key`) and developer tokens
 * (`dev_tokens.token`) were stored in plaintext. This step moves each secret
 * to its SHA-256, in the same transaction, and leaves a non-secret
 * placeholder in the old column (it is NOT NULL and UNIQUE, and a table
 * rebuild would be needed to drop it).
 *
 * It is safe to run on every start:
 *  - only rows that still hold a plaintext value (no hash yet, value is not a
 *    placeholder) are touched, so a second run changes nothing;
 *  - a crash between the ALTER and the backfill is repaired by the next start,
 *    because the backfill is driven by the data, not by "the column was just
 *    added";
 *  - existing keys keep working: the hash of the key a person already holds is
 *    what is stored, so nothing needs to be re-issued.
 *
 * Roll-back note: the previous release compares the plaintext column, so a
 * roll-back to it leaves every key unrecognised until keys are rotated. The
 * report says so.
 */

export interface TokenMigrationResult {
  appKeys: number;
  devTokens: number;
}

function hasColumn(db: DatabaseSync, table: string, column: string): boolean {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  return cols.some((c) => c.name === column);
}

export function migrateTokenStorage(db: DatabaseSync): TokenMigrationResult {
  db.exec("BEGIN");
  try {
    // ── App API keys ────────────────────────────────────────────────
    if (!hasColumn(db, "apps", "api_key_hash")) {
      db.exec(`ALTER TABLE apps ADD COLUMN api_key_hash TEXT`);
    }
    if (!hasColumn(db, "apps", "api_key_hint")) {
      db.exec(`ALTER TABLE apps ADD COLUMN api_key_hint TEXT`);
    }
    // S11: the key being replaced stays valid until this moment, if the
    // person asked for an overlap, so a rotation does not break a pipeline
    // that has not been updated yet.
    if (!hasColumn(db, "apps", "prev_key_hash")) {
      db.exec(`ALTER TABLE apps ADD COLUMN prev_key_hash TEXT`);
    }
    if (!hasColumn(db, "apps", "prev_key_expires_at")) {
      db.exec(`ALTER TABLE apps ADD COLUMN prev_key_expires_at TEXT`);
    }
    db.exec(
      `CREATE UNIQUE INDEX IF NOT EXISTS idx_apps_key_hash ON apps(api_key_hash) WHERE api_key_hash IS NOT NULL`
    );
    db.exec(
      `CREATE INDEX IF NOT EXISTS idx_apps_prev_key_hash ON apps(prev_key_hash) WHERE prev_key_hash IS NOT NULL`
    );

    const apps = db
      .prepare(`SELECT id, api_key FROM apps WHERE api_key_hash IS NULL`)
      .all() as Array<{ id: string; api_key: string }>;
    const setApp = db.prepare(
      `UPDATE apps SET api_key_hash = ?, api_key_hint = ?, api_key = ? WHERE id = ?`
    );
    let appKeys = 0;
    for (const row of apps) {
      if (isPlaceholder(row.api_key)) continue; // nothing left to hash
      setApp.run(hashToken(row.api_key), tokenHint(row.api_key), placeholderFor(row.id), row.id);
      appKeys++;
    }

    // ── Developer tokens (skills MCP) ───────────────────────────────
    if (!hasColumn(db, "dev_tokens", "token_hash")) {
      db.exec(`ALTER TABLE dev_tokens ADD COLUMN token_hash TEXT`);
    }
    if (!hasColumn(db, "dev_tokens", "token_hint")) {
      db.exec(`ALTER TABLE dev_tokens ADD COLUMN token_hint TEXT`);
    }
    if (!hasColumn(db, "dev_tokens", "expires_at")) {
      // NULL = never expires. Existing tokens keep working as they were; only
      // new ones get an expiry. The tokens list says which have none.
      db.exec(`ALTER TABLE dev_tokens ADD COLUMN expires_at TEXT`);
    }
    db.exec(
      `CREATE UNIQUE INDEX IF NOT EXISTS idx_dev_tokens_hash ON dev_tokens(token_hash) WHERE token_hash IS NOT NULL`
    );
    const tokens = db
      .prepare(`SELECT id, token FROM dev_tokens WHERE token_hash IS NULL`)
      .all() as Array<{ id: string; token: string }>;
    const setToken = db.prepare(
      `UPDATE dev_tokens SET token_hash = ?, token_hint = ?, token = ? WHERE id = ?`
    );
    let devTokens = 0;
    for (const row of tokens) {
      if (isPlaceholder(row.token)) continue;
      setToken.run(hashToken(row.token), tokenHint(row.token), placeholderFor(row.id), row.id);
      devTokens++;
    }

    db.exec("COMMIT");
    return { appKeys, devTokens };
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
}

/** The table for user tokens (rwu_). Created idempotently. */
export function ensureUserTokensTable(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS user_tokens (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      token_hash TEXT NOT NULL UNIQUE,
      token_hint TEXT NOT NULL,
      name TEXT NOT NULL,
      -- read < deploy < admin. One level per token; a higher one includes the lower.
      scope TEXT NOT NULL DEFAULT 'read',
      expires_at TEXT NOT NULL,
      last_used_at TEXT,
      revoked_at TEXT,
      revoked_by TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_user_tokens_user ON user_tokens(user_id);
  `);
}
