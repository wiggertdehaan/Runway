import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";

const DB_PATH = process.env.DB_PATH || join(process.cwd(), "runway.db");

export const db = new DatabaseSync(DB_PATH);

// Enable WAL mode for better concurrent read performance
db.exec("PRAGMA journal_mode = WAL");
db.exec("PRAGMA foreign_keys = ON");

export function migrate() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      username TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS sessions (
      token TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      expires_at TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);

    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS apps (
      id TEXT PRIMARY KEY,
      name TEXT,
      api_key TEXT NOT NULL UNIQUE,
      runtime TEXT,
      port INTEGER NOT NULL DEFAULT 3000,
      domain TEXT,
      cpu_limit TEXT DEFAULT '1',
      memory_limit TEXT DEFAULT '512m',
      status TEXT NOT NULL DEFAULT 'created',
      image_tag TEXT,
      container_id TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS env_vars (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      app_id TEXT NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
      key TEXT NOT NULL,
      value TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(app_id, key)
    );

    CREATE TABLE IF NOT EXISTS deploys (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      app_id TEXT NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
      commit_sha TEXT,
      image_tag TEXT,
      status TEXT NOT NULL DEFAULT 'pending',
      log TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);

  // Upgrade legacy apps tables created before the MCP-driven
  // configure flow: name and runtime were NOT NULL and the
  // image_tag / container_id columns did not exist. Rebuild the
  // table in place so existing installations pick up the new
  // schema without losing their apps.
  const columns = db.prepare("PRAGMA table_info(apps)").all() as Array<{
    name: string;
    notnull: number;
  }>;

  const nameCol = columns.find((c) => c.name === "name");
  const hasImageTag = columns.some((c) => c.name === "image_tag");
  const hasContainerId = columns.some((c) => c.name === "container_id");
  const needsRebuild =
    (nameCol && nameCol.notnull === 1) || !hasImageTag || !hasContainerId;

  if (needsRebuild) {
    db.exec(`
      BEGIN;

      CREATE TABLE apps_new (
        id TEXT PRIMARY KEY,
        name TEXT,
        api_key TEXT NOT NULL UNIQUE,
        runtime TEXT,
        port INTEGER NOT NULL DEFAULT 3000,
        domain TEXT,
        cpu_limit TEXT DEFAULT '1',
        memory_limit TEXT DEFAULT '512m',
        status TEXT NOT NULL DEFAULT 'created',
        image_tag TEXT,
        container_id TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      );

      INSERT INTO apps_new (
        id, name, api_key, runtime, port, domain,
        cpu_limit, memory_limit, status, created_at, updated_at
      )
      SELECT
        id, name, api_key, runtime, port, domain,
        cpu_limit, memory_limit, status, created_at, updated_at
      FROM apps;

      DROP TABLE apps;
      ALTER TABLE apps_new RENAME TO apps;

      COMMIT;
    `);
  }
}
