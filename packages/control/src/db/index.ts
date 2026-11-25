import { ensureEventsTables } from "./events-schema.js";
import { ensureHostTables } from "../host/schema.js";
import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";
import { ensureUniqueDomainIndexes } from "./domain-index.js";
import { backfillOwnerUserIds } from "./owner-migration.js";
import {
  LEGACY_DEV_TOKEN_DAYS,
  ensureUserTokensTable,
  expireLegacyDevTokens,
  migrateTokenStorage,
} from "./token-migration.js";

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
      role TEXT NOT NULL DEFAULT 'member',
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS sessions (
      token TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      expires_at TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);

    -- S02: sign-ins of SSO app hosts, separate from the dashboard session.
    CREATE TABLE IF NOT EXISTS sso_tickets (
      hash TEXT PRIMARY KEY,
      host TEXT NOT NULL,
      app_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      parent_token TEXT NOT NULL,
      expires_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_sso_tickets_parent ON sso_tickets(parent_token);

    CREATE TABLE IF NOT EXISTS sso_sessions (
      hash TEXT PRIMARY KEY,
      host TEXT NOT NULL,
      app_id TEXT NOT NULL,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      parent_token TEXT NOT NULL,
      expires_at INTEGER NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_sso_sessions_parent ON sso_sessions(parent_token);
    CREATE INDEX IF NOT EXISTS idx_sso_sessions_user ON sso_sessions(user_id);

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

    -- Each accepted TOTP counter is recorded so that the same code
    -- cannot be submitted twice within the drift window. Rows are
    -- trimmed opportunistically when a new code is accepted.
    CREATE TABLE IF NOT EXISTS used_totp_counters (
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      counter INTEGER NOT NULL,
      used_at TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (user_id, counter)
    );

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

  // S12: the audit log also records what the API and the MCP route do, and
  // who tried and failed. Extra columns, all nullable or defaulted, so every
  // existing row stays valid (actor_type NULL = a person using the dashboard).
  const auditCols = db.prepare("PRAGMA table_info(audit_log)").all() as Array<{
    name: string;
  }>;
  for (const [col, ddl] of [
    ["actor_type", "TEXT"],
    ["app_id", "TEXT"],
    ["result", "TEXT"],
    ["source_ip", "TEXT"],
    ["count", "INTEGER NOT NULL DEFAULT 1"],
  ] as const) {
    if (!auditCols.some((c) => c.name === col)) {
      db.exec(`ALTER TABLE audit_log ADD COLUMN ${col} ${ddl}`);
    }
  }
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_audit_actor ON audit_log(actor_type, id);
    CREATE INDEX IF NOT EXISTS idx_audit_denied ON audit_log(action, source_ip, id);
    CREATE INDEX IF NOT EXISTS idx_audit_app ON audit_log(app_id, id);
  `);

  // S09: failed second-factor attempts per user. Kept in the database (not
  // in memory) so a restart does not hand an attacker a fresh set of guesses,
  // and keyed on the user (not the IP) so a password-holder cannot reset it
  // by signing in again. See auth/twofa-limit.ts for the schedule.
  db.exec(`
    CREATE TABLE IF NOT EXISTS twofa_attempts (
      user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
      failures INTEGER NOT NULL DEFAULT 0,
      last_failure_at INTEGER NOT NULL DEFAULT 0,
      locked_until INTEGER NOT NULL DEFAULT 0
    );
  `);
  // S09: failed attempts against one pre-auth session. After a handful the
  // session is destroyed, so the attacker must enter the password again.
  const preauthCols = db.prepare("PRAGMA table_info(preauth_sessions)").all() as Array<{
    name: string;
  }>;
  if (!preauthCols.some((c) => c.name === "failures")) {
    db.exec(`ALTER TABLE preauth_sessions ADD COLUMN failures INTEGER NOT NULL DEFAULT 0`);
  }

  // Upgrade legacy users tables so existing installations pick up
  // the totp columns. ADD COLUMN is supported by SQLite.
  const userColumns = db.prepare("PRAGMA table_info(users)").all() as Array<{
    name: string;
  }>;
  if (!userColumns.some((c) => c.name === "email")) {
    db.exec(`ALTER TABLE users ADD COLUMN email TEXT`);
    db.exec(
      `CREATE UNIQUE INDEX IF NOT EXISTS idx_users_email ON users(email) WHERE email IS NOT NULL`
    );
  }
  if (!userColumns.some((c) => c.name === "oauth_provider")) {
    db.exec(`ALTER TABLE users ADD COLUMN oauth_provider TEXT`);
  }
  // S01: the provider identity (`sub`) an OAuth user first signed in with.
  // Later logins must present the same one, so a second account that merely
  // claims the same email address cannot take the account over.
  if (!userColumns.some((c) => c.name === "oauth_sub")) {
    db.exec(`ALTER TABLE users ADD COLUMN oauth_sub TEXT`);
  }
  // S01: who may create an account by signing in with Google/Microsoft.
  // Empty by default: nobody new gets in until an admin allows them.
  db.exec(`
    CREATE TABLE IF NOT EXISTS oauth_access (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      kind TEXT NOT NULL CHECK (kind IN ('email','domain')),
      value TEXT NOT NULL,
      one_time INTEGER NOT NULL DEFAULT 0,
      created_by TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(kind, value)
    );
  `);
  if (!userColumns.some((c) => c.name === "totp_secret")) {
    db.exec(`ALTER TABLE users ADD COLUMN totp_secret TEXT`);
  }
  if (!userColumns.some((c) => c.name === "totp_enabled")) {
    db.exec(
      `ALTER TABLE users ADD COLUMN totp_enabled INTEGER NOT NULL DEFAULT 0`
    );
  }
  if (!userColumns.some((c) => c.name === "role")) {
    // Pre-upgrade, every user had full rights. Preserve that by
    // promoting all existing users to admin; new users created after
    // this migration default to member and have to be promoted by an
    // admin.
    db.exec(`ALTER TABLE users ADD COLUMN role TEXT NOT NULL DEFAULT 'member'`);
    db.exec(`UPDATE users SET role = 'admin'`);
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
  // S03: one app per hostname. Creates the unique indexes unless the
  // installation already holds duplicates, which are then reported.
  ensureUniqueDomainIndexes(db);
  if (!appCols.some((c) => c.name === "health_check_path")) {
    db.exec(`ALTER TABLE apps ADD COLUMN health_check_path TEXT`);
  }
  if (!appCols.some((c) => c.name === "created_by")) {
    db.exec(`ALTER TABLE apps ADD COLUMN created_by TEXT`);
  }
  // S13: ownership by user id. The column and the one-time fill of it share
  // a transaction, so a crash cannot leave the column added but empty (the
  // fill would then never run). See owner-migration.ts for why it must not
  // be repeated on later starts.
  if (!appCols.some((c) => c.name === "owner_user_id")) {
    db.exec("BEGIN");
    try {
      db.exec(`ALTER TABLE apps ADD COLUMN owner_user_id TEXT`);
      backfillOwnerUserIds(db);
      db.exec("COMMIT");
    } catch (err) {
      db.exec("ROLLBACK");
      throw err;
    }
  }
  if (!appCols.some((c) => c.name === "scan_threshold")) {
    db.exec(`ALTER TABLE apps ADD COLUMN scan_threshold TEXT NOT NULL DEFAULT 'none'`);
  }
  if (!appCols.some((c) => c.name === "scan_floor_exempt")) {
    db.exec(
      `ALTER TABLE apps ADD COLUMN scan_floor_exempt INTEGER NOT NULL DEFAULT 0`
    );
  }
  if (!appCols.some((c) => c.name === "sso_enabled")) {
    db.exec(
      `ALTER TABLE apps ADD COLUMN sso_enabled INTEGER NOT NULL DEFAULT 0`
    );
  }

  // SSO per-app email allowlist
  db.exec(`
    CREATE TABLE IF NOT EXISTS app_allowed_emails (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      app_id TEXT NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
      email TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(app_id, email)
    );
    CREATE INDEX IF NOT EXISTS idx_app_allowed_emails_app
      ON app_allowed_emails(app_id);
  `);
  if (!appCols.some((c) => c.name === "basic_auth_enabled")) {
    db.exec(
      `ALTER TABLE apps ADD COLUMN basic_auth_enabled INTEGER NOT NULL DEFAULT 0`
    );
  }
  if (!appCols.some((c) => c.name === "basic_auth_username")) {
    db.exec(`ALTER TABLE apps ADD COLUMN basic_auth_username TEXT`);
  }
  if (!appCols.some((c) => c.name === "basic_auth_htpasswd")) {
    db.exec(`ALTER TABLE apps ADD COLUMN basic_auth_htpasswd TEXT`);
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

  // Per-app activity tracking. last_request_at powers the dashboard
  // "Active 5m / Idle 3d" label; app_request_buckets stores hourly
  // counts for the 7-day sparkline. Both are populated by the access
  // log tailer in deploy/activity-tailer.ts.
  if (!appCols.some((c) => c.name === "last_request_at")) {
    db.exec(`ALTER TABLE apps ADD COLUMN last_request_at TEXT`);
  }
  db.exec(`
    CREATE TABLE IF NOT EXISTS app_request_buckets (
      app_id TEXT NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
      hour_at TEXT NOT NULL,
      count INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (app_id, hour_at)
    );
    CREATE INDEX IF NOT EXISTS idx_request_buckets_hour
      ON app_request_buckets(hour_at);
  `);

  // Phase 2: skill distribution. Developer tokens authenticate Claude
  // Code (or any MCP client) against /mcp; skills + skill_files store
  // SKILL.md and assets; per-skill admin actions are recorded in the
  // shared audit_log table (skill_uploaded / enabled / disabled /
  // deleted); app_skill_profiles is a per-app suggestion list, not a
  // gate.
  db.exec(`
    CREATE TABLE IF NOT EXISTS dev_tokens (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      token TEXT NOT NULL UNIQUE,
      name TEXT NOT NULL,
      last_used_at TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_dev_tokens_user ON dev_tokens(user_id);

    CREATE TABLE IF NOT EXISTS skills (
      id TEXT PRIMARY KEY,
      layer TEXT NOT NULL,
      name TEXT NOT NULL,
      description TEXT,
      version TEXT NOT NULL DEFAULT '0.0.1',
      enabled INTEGER NOT NULL DEFAULT 1,
      source_url TEXT,
      signed INTEGER NOT NULL DEFAULT 0,
      is_managed INTEGER NOT NULL DEFAULT 0,
      approved_by TEXT REFERENCES users(id) ON DELETE SET NULL,
      approved_at TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_skills_layer ON skills(layer);

    CREATE TABLE IF NOT EXISTS skill_files (
      skill_id TEXT NOT NULL REFERENCES skills(id) ON DELETE CASCADE,
      path TEXT NOT NULL,
      content BLOB NOT NULL,
      mime_type TEXT NOT NULL,
      PRIMARY KEY (skill_id, path)
    );

    CREATE TABLE IF NOT EXISTS app_skill_profiles (
      app_id TEXT NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
      skill_id TEXT NOT NULL REFERENCES skills(id) ON DELETE CASCADE,
      PRIMARY KEY (app_id, skill_id)
    );
  `);

  // Drop the old skill_audit table on installs that ran the 0.13.0
  // migration. Skill admin actions are recorded in the shared
  // audit_log table; the dedicated table was never written to.
  db.exec(`DROP TABLE IF EXISTS skill_audit`);

  // bundle_sha256 records the hash computed at curated-import time so
  // an admin can spot a silent upstream change on re-import.
  const skillCols = db.prepare("PRAGMA table_info(skills)").all() as Array<{
    name: string;
  }>;
  if (!skillCols.some((c) => c.name === "bundle_sha256")) {
    db.exec(`ALTER TABLE skills ADD COLUMN bundle_sha256 TEXT`);
  }

  // Periodic image rescans. Trivy refreshes its CVE DB on a schedule
  // (~6h); a deploy that passed the gate at build time can develop new
  // findings later. The periodic scanner writes one row per scan so
  // the dashboard can show a delta against the previous run.
  // Rebuild-all: per-app opt-out for the weekly automatic rebuild, and
  // a history of rebuild runs (manual + scheduled). `results` is a JSON
  // array of per-app outcomes, rewritten after each app so the dashboard
  // can show progress while a run is in flight.
  if (!appCols.some((c) => c.name === "auto_rebuild")) {
    db.exec(`ALTER TABLE apps ADD COLUMN auto_rebuild INTEGER NOT NULL DEFAULT 1`);
  }
  // Auto-patch of base images on rebuild: per-app opt-out, and which base
  // images (tag + digest, and whether auto-raised) each deploy used.
  if (!appCols.some((c) => c.name === "auto_patch_base")) {
    db.exec(`ALTER TABLE apps ADD COLUMN auto_patch_base INTEGER NOT NULL DEFAULT 1`);
  }
  if (!deployCols.some((c) => c.name === "base_images")) {
    db.exec(`ALTER TABLE deploys ADD COLUMN base_images TEXT`);
  }
  // Minor-line escalation opt-out + KEV quarantine (see deploy/quarantine.ts).
  if (!appCols.some((c) => c.name === "auto_minor_base")) {
    db.exec(`ALTER TABLE apps ADD COLUMN auto_minor_base INTEGER NOT NULL DEFAULT 1`);
  }
  // Dependency auto-update on rebuild (see deploy/dep-updates.ts): per-app
  // opt-out, and a memory of attempts so a version that failed to build or
  // start is not retried on every weekly run.
  if (!appCols.some((c) => c.name === "auto_update_deps")) {
    db.exec(`ALTER TABLE apps ADD COLUMN auto_update_deps INTEGER NOT NULL DEFAULT 1`);
  }
  // Major jumps are a separate, explicit opt-in (default off, also for
  // apps that existed before): a healthcheck only proves the app starts.
  if (!appCols.some((c) => c.name === "auto_update_deps_major")) {
    db.exec(`ALTER TABLE apps ADD COLUMN auto_update_deps_major INTEGER NOT NULL DEFAULT 0`);
  }
  // Container hardening (S08, see deploy/hardening.ts): an administrator's
  // per-app profile (NULL = the instance default) and an opt-in read-only
  // root filesystem. Both take effect when the container is next created.
  if (!appCols.some((c) => c.name === "hardening_profile")) {
    db.exec(`ALTER TABLE apps ADD COLUMN hardening_profile TEXT`);
  }
  if (!appCols.some((c) => c.name === "readonly_rootfs")) {
    db.exec(`ALTER TABLE apps ADD COLUMN readonly_rootfs INTEGER NOT NULL DEFAULT 0`);
  }
  // Short plain-text description ("what is it, for whom"). NULL = none. Filled
  // from the README on a deploy only while it is empty; a hand-written one is
  // never overwritten (db/apps.ts setDescriptionIfEmpty).
  if (!appCols.some((c) => c.name === "description")) {
    db.exec(`ALTER TABLE apps ADD COLUMN description TEXT`);
  }
  // Lifecycle: `stopped_at` = when a person stopped the app (kept while it is
  // stopped, used to pause the KEV clock); `deleted_at` = moved to the trash
  // (7 days, then purged). A trashed app keeps its row, domain and data.
  if (!appCols.some((c) => c.name === "stopped_at")) {
    db.exec(`ALTER TABLE apps ADD COLUMN stopped_at TEXT`);
  }
  if (!appCols.some((c) => c.name === "deleted_at")) {
    db.exec(`ALTER TABLE apps ADD COLUMN deleted_at TEXT`);
  }
  db.exec(`
    CREATE TABLE IF NOT EXISTS dep_update_attempts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      app_id TEXT NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
      dep_key TEXT NOT NULL,
      outcome TEXT NOT NULL,
      detail TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_dep_update_attempts_app
      ON dep_update_attempts(app_id, id DESC);
  `);
  db.exec(`
    CREATE TABLE IF NOT EXISTS app_quarantine (
      app_id TEXT PRIMARY KEY REFERENCES apps(id) ON DELETE CASCADE,
      state TEXT NOT NULL,
      kev_first_seen TEXT NOT NULL DEFAULT '{}',
      attempt_at TEXT,
      quarantined_at TEXT,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS quarantine_exemptions (
      app_id TEXT PRIMARY KEY REFERENCES apps(id) ON DELETE CASCADE,
      reason TEXT NOT NULL,
      until TEXT NOT NULL,
      granted_by TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS app_notices (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      app_id TEXT NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
      kind TEXT NOT NULL,
      message TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_app_notices_app
      ON app_notices(app_id, id DESC);
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS rebuild_runs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      trigger TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'running',
      started_at TEXT NOT NULL DEFAULT (datetime('now')),
      finished_at TEXT,
      results TEXT NOT NULL DEFAULT '[]'
    );
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS app_periodic_scans (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      app_id TEXT NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
      image_tag TEXT NOT NULL,
      scan_status TEXT NOT NULL,
      scan_summary TEXT NOT NULL,
      scan_report TEXT,
      error TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_periodic_scans_app_recent
      ON app_periodic_scans(app_id, created_at DESC);
  `);

  // S10/S11/S18: tokens are kept as hashes, and users can hold tokens of their
  // own. See token-migration.ts for why this is safe to run on every start.
  const moved = migrateTokenStorage(db);
  if (moved.appKeys > 0 || moved.devTokens > 0) {
    console.log(
      `Stored ${moved.appKeys} app key(s) and ${moved.devTokens} developer token(s) as hashes. ` +
        `Keys still work; the dashboard can no longer show an old key (rotate to get a new one).`
    );
  }
  // Developer tokens that never expire get an expiry (90 days) so none lives forever.
  const dated = expireLegacyDevTokens(db);
  if (dated > 0) {
    console.log(
      `${dated} developer token(s) had no expiry and now expire in ${LEGACY_DEV_TOKEN_DAYS} days. ` +
        `They work until then; their owners are told on the Account page.`
    );
  }
  ensureUserTokensTable(db);
  ensureEventsTables(db);
  ensureHostTables(db);

  // S02: until now the session cookie was set on `.{base_domain}`, so every
  // deployed app received a valid dashboard session. Those tokens are
  // therefore treated as exposed: once, on the first start of this version,
  // every dashboard session is ended. Users sign in again (one time). The
  // marker keeps later starts from signing everyone out again. A fresh
  // install has no sessions, so this is a no-op there.
  const marker = db
    .prepare(`SELECT 1 AS done FROM settings WHERE key = 'sessions_host_only_v1'`)
    .get();
  if (!marker) {
    db.exec("BEGIN");
    try {
      db.exec(`DELETE FROM sessions`);
      db.prepare(
        `INSERT INTO settings (key, value, updated_at) VALUES ('sessions_host_only_v1', '1', datetime('now'))`
      ).run();
      db.exec("COMMIT");
    } catch (err) {
      db.exec("ROLLBACK");
      throw err;
    }
  }
}
