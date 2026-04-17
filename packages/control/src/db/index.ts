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
      totp_secret TEXT,
      totp_enabled INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS sessions (
      token TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      expires_at TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);

    CREATE TABLE IF NOT EXISTS preauth_sessions (
      token TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      expires_at TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS user_backup_codes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      code_hash TEXT NOT NULL,
      used_at TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_backup_codes_user
      ON user_backup_codes(user_id) WHERE used_at IS NULL;

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

    CREATE TABLE IF NOT EXISTS volumes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      app_id TEXT NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
      mount_path TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(app_id, mount_path)
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

    CREATE TABLE IF NOT EXISTS audit_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id TEXT NOT NULL,
      username TEXT NOT NULL,
      action TEXT NOT NULL,
      target_user_id TEXT,
      target_username TEXT,
      detail TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);

  // Upgrade legacy users tables so existing installations pick up
  // the totp columns. ADD COLUMN is supported by SQLite.
  const userColumns = db.prepare("PRAGMA table_info(users)").all() as Array<{
    name: string;
  }>;
  if (!userColumns.some((c) => c.name === "totp_secret")) {
    db.exec(`ALTER TABLE users ADD COLUMN totp_secret TEXT`);
  }
  if (!userColumns.some((c) => c.name === "totp_enabled")) {
    db.exec(
      `ALTER TABLE users ADD COLUMN totp_enabled INTEGER NOT NULL DEFAULT 0`
    );
  }

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

  // Add custom_domain and health_check_path columns for existing installs.
  const appCols = db.prepare("PRAGMA table_info(apps)").all() as Array<{
    name: string;
  }>;
  if (!appCols.some((c) => c.name === "custom_domain")) {
    db.exec(`ALTER TABLE apps ADD COLUMN custom_domain TEXT`);
  }
  if (!appCols.some((c) => c.name === "health_check_path")) {
    db.exec(`ALTER TABLE apps ADD COLUMN health_check_path TEXT`);
  }
  if (!appCols.some((c) => c.name === "created_by")) {
    db.exec(`ALTER TABLE apps ADD COLUMN created_by TEXT`);
  }
  if (!appCols.some((c) => c.name === "scan_threshold")) {
    db.exec(`ALTER TABLE apps ADD COLUMN scan_threshold TEXT NOT NULL DEFAULT 'none'`);
  }

  // Scan results are attached to individual deploys so history is preserved.
  const deployCols = db.prepare("PRAGMA table_info(deploys)").all() as Array<{
    name: string;
  }>;
  if (!deployCols.some((c) => c.name === "scan_status")) {
    db.exec(`ALTER TABLE deploys ADD COLUMN scan_status TEXT`);
  }
  if (!deployCols.some((c) => c.name === "scan_summary")) {
    db.exec(`ALTER TABLE deploys ADD COLUMN scan_summary TEXT`);
  }
  if (!deployCols.some((c) => c.name === "scan_report")) {
    db.exec(`ALTER TABLE deploys ADD COLUMN scan_report TEXT`);
  }
}
