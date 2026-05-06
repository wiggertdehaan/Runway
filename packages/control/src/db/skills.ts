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
}

export function upsertSkill(input: UpsertSkillInput): void {
  db.prepare(
    `INSERT INTO skills (id, layer, name, description, version, is_managed, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, datetime('now'))
     ON CONFLICT(id) DO UPDATE SET
       layer = excluded.layer,
       name = excluded.name,
       description = excluded.description,
       version = excluded.version,
       is_managed = excluded.is_managed,
       updated_at = datetime('now')`,
  ).run(
    input.id,
    input.layer,
    input.name,
    input.description ?? null,
    input.version ?? "0.0.1",
    input.is_managed ? 1 : 0,
  );
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
