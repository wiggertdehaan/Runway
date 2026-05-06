import { db } from "./index.js";

/**
 * Per-app "relevant skills" suggestions. This is purely advisory:
 * Claude Code (and other agents) get this list back via /api/v1/app
 * and may use it to prioritize which skills to read first, but the
 * MCP server still serves every enabled skill to any authenticated
 * developer token. Compliance is enforced at deploy time via
 * scan_threshold, not here.
 */

export function getAppSkillIds(appId: string): string[] {
  const rows = db
    .prepare(
      `SELECT skill_id FROM app_skill_profiles WHERE app_id = ? ORDER BY skill_id`,
    )
    .all(appId) as unknown as Array<{ skill_id: string }>;
  return rows.map((r) => r.skill_id);
}

export function setAppSkillIds(appId: string, skillIds: string[]): void {
  db.prepare(`DELETE FROM app_skill_profiles WHERE app_id = ?`).run(appId);
  if (skillIds.length === 0) return;
  const insert = db.prepare(
    `INSERT OR IGNORE INTO app_skill_profiles (app_id, skill_id) VALUES (?, ?)`,
  );
  for (const id of skillIds) insert.run(appId, id);
}
