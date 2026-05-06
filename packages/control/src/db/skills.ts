import { db } from "./index.js";

export type SkillLayer = "builtin" | "curated" | "custom";

export interface Skill {
  id: string;
  layer: SkillLayer;
  name: string;
  description: string | null;
  version: string;
  enabled: number;
  source_url: string | null;
  signed: number;
  is_managed: number;
  approved_by: string | null;
  approved_at: string | null;
  bundle_sha256: string | null;
  created_at: string;
  updated_at: string;
}

export interface SkillFile {
  skill_id: string;
  path: string;
  content: Uint8Array;
  mime_type: string;
}

export function listEnabledSkills(): Skill[] {
  return db
    .prepare(
      `SELECT * FROM skills
       WHERE enabled = 1
       ORDER BY
         CASE layer WHEN 'custom' THEN 0 WHEN 'curated' THEN 1 ELSE 2 END,
         name`,
    )
    .all() as unknown as Skill[];
}

export function listAllSkills(): Skill[] {
  return db
    .prepare(
      `SELECT * FROM skills
       ORDER BY
         CASE layer WHEN 'custom' THEN 0 WHEN 'curated' THEN 1 ELSE 2 END,
         name`,
    )
    .all() as unknown as Skill[];
}

export function setSkillEnabled(id: string, enabled: boolean): boolean {
  const result = db
    .prepare(
      `UPDATE skills SET enabled = ?, updated_at = datetime('now') WHERE id = ?`,
    )
    .run(enabled ? 1 : 0, id);
  return result.changes > 0;
}

/**
 * Delete a skill row and all of its files. Refuses to delete
 * `is_managed` (built-in) skills — those are restored from disk on
 * every restart, so a user-initiated delete would just resurrect
 * them and look broken.
 */
export function deleteCustomSkill(id: string): boolean {
  const skill = getSkill(id);
  if (!skill || skill.is_managed) return false;
  const result = db.prepare(`DELETE FROM skills WHERE id = ?`).run(id);
  return result.changes > 0;
}

export function getSkill(id: string): Skill | undefined {
  return db
    .prepare(`SELECT * FROM skills WHERE id = ?`)
    .get(id) as unknown as Skill | undefined;
}

export function getSkillFile(
  skillId: string,
  path: string,
): SkillFile | undefined {
  return db
    .prepare(
      `SELECT skill_id, path, content, mime_type
       FROM skill_files WHERE skill_id = ? AND path = ?`,
    )
    .get(skillId, path) as unknown as SkillFile | undefined;
}

export interface UpsertSkillInput {
  id: string;
  layer: SkillLayer;
  name: string;
  description?: string | null;
  version?: string;
  is_managed?: boolean;
  source_url?: string | null;
  signed?: boolean;
  bundle_sha256?: string | null;
  approved_by?: string | null;
}

export function upsertSkill(input: UpsertSkillInput): void {
  const stamp = input.approved_by ? "datetime('now')" : "approved_at";
  db.prepare(
    `INSERT INTO skills (
       id, layer, name, description, version, is_managed,
       source_url, signed, bundle_sha256, approved_by, approved_at,
       updated_at
     )
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ${input.approved_by ? "datetime('now')" : "NULL"}, datetime('now'))
     ON CONFLICT(id) DO UPDATE SET
       layer = excluded.layer,
       name = excluded.name,
       description = excluded.description,
       version = excluded.version,
       is_managed = excluded.is_managed,
       source_url = excluded.source_url,
       signed = excluded.signed,
       bundle_sha256 = excluded.bundle_sha256,
       approved_by = COALESCE(excluded.approved_by, skills.approved_by),
       approved_at = ${stamp},
       updated_at = datetime('now')`,
  ).run(
    input.id,
    input.layer,
    input.name,
    input.description ?? null,
    input.version ?? "0.0.1",
    input.is_managed ? 1 : 0,
    input.source_url ?? null,
    input.signed ? 1 : 0,
    input.bundle_sha256 ?? null,
    input.approved_by ?? null,
  );
}

/**
 * Drop every file row attached to a skill. Used before re-importing
 * a curated skill so a renamed-or-removed file in the upstream bundle
 * doesn't linger in our copy.
 */
export function deleteSkillFiles(skillId: string): void {
  db.prepare(`DELETE FROM skill_files WHERE skill_id = ?`).run(skillId);
}

export function putSkillFile(
  skillId: string,
  path: string,
  content: Uint8Array,
  mimeType: string,
): void {
  db.prepare(
    `INSERT INTO skill_files (skill_id, path, content, mime_type)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(skill_id, path) DO UPDATE SET
       content = excluded.content,
       mime_type = excluded.mime_type`,
  ).run(skillId, path, content, mimeType);
}
