import { db } from "./index.js";

export interface EnvVar {
  key: string;
  value: string;
}

export function getEnvVars(appId: string): Record<string, string> {
  const rows = db
    .prepare(`SELECT key, value FROM env_vars WHERE app_id = ?`)
    .all(appId) as unknown as EnvVar[];
  const env: Record<string, string> = {};
  for (const row of rows) {
    env[row.key] = row.value;
  }
  return env;
}

export function setEnvVars(
  appId: string,
  vars: Record<string, string>
): void {
  const upsert = db.prepare(
    `INSERT INTO env_vars (app_id, key, value)
     VALUES (?, ?, ?)
     ON CONFLICT(app_id, key) DO UPDATE SET value = excluded.value`
  );
  for (const [key, value] of Object.entries(vars)) {
    upsert.run(appId, key, value);
  }
}

export function deleteEnvVar(appId: string, key: string): boolean {
  const result = db
    .prepare(`DELETE FROM env_vars WHERE app_id = ? AND key = ?`)
    .run(appId, key);
  return result.changes > 0;
}
