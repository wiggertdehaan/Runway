import type { DatabaseSync } from "node:sqlite";

/** Kept apart from store.ts so the migration does not import the database it is run on. */
export function ensureHostTables(database: DatabaseSync): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS host_metrics (
      kind TEXT NOT NULL,
      ts INTEGER NOT NULL,
      value REAL NOT NULL,
      n INTEGER NOT NULL DEFAULT 1,
      PRIMARY KEY (kind, ts)
    ) WITHOUT ROWID;
    CREATE INDEX IF NOT EXISTS idx_host_metrics_ts ON host_metrics(ts);
    CREATE TABLE IF NOT EXISTS host_state (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    );
  `);
}

