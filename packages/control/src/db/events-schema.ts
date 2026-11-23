import type { DatabaseSync } from "node:sqlite";

/** Kept apart from events.ts so the migration does not import the database it is run on. */
export function ensureEventsTables(database: DatabaseSync): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS app_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      app_id TEXT NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
      ts TEXT NOT NULL,
      type TEXT NOT NULL,
      code TEXT NOT NULL,
      severity TEXT NOT NULL,
      detail TEXT,
      dedupe_key TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_app_events_app ON app_events(app_id, id);
    CREATE INDEX IF NOT EXISTS idx_app_events_dedupe ON app_events(app_id, dedupe_key, ts);
    CREATE TABLE IF NOT EXISTS event_meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
  `);
}
