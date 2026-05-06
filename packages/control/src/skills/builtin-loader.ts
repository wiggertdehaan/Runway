import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import yaml from "js-yaml";
import {
  putSkillFile,
  upsertSkill,
  type SkillLayer,
} from "../db/skills.js";

const SKILL_MD = "SKILL.md";
const BUILTIN_LAYER: SkillLayer = "builtin";

// Resolved relative to this file so the loader works whether we run
// from src/ (tsx dev) or dist/ (Docker runtime). Both compile down to
// packages/control/skills/builtin/.
const BUILTIN_DIR = fileURLToPath(
  new URL("../../skills/builtin", import.meta.url),
);

interface FrontMatter {
  name?: string;
  description?: string;
  version?: string;
}

const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/;

function parseFrontmatter(source: string): FrontMatter {
  const match = source.match(FRONTMATTER_RE);
  if (!match) return {};
  const parsed = yaml.load(match[1]!);
  if (!parsed || typeof parsed !== "object") return {};
  return parsed as FrontMatter;
}

function mimeFor(path: string): string {
  if (path.endsWith(".md")) return "text/markdown";
  if (path.endsWith(".txt")) return "text/plain";
  if (path.endsWith(".json")) return "application/json";
  if (path.endsWith(".yaml") || path.endsWith(".yml")) return "application/yaml";
  if (path.endsWith(".sh")) return "text/x-shellscript";
  if (path.endsWith(".dockerfile") || path.endsWith("Dockerfile"))
    return "text/x-dockerfile";
  return "application/octet-stream";
}

function walk(root: string, current: string): string[] {
  const results: string[] = [];
  for (const entry of readdirSync(current)) {
    const full = join(current, entry);
    const st = statSync(full);
    if (st.isDirectory()) results.push(...walk(root, full));
    else results.push(relative(root, full).split(sep).join("/"));
  }
  return results;
}

/**
 * Load every builtin skill from packages/control/skills/builtin/<id>/
 * into the skills + skill_files tables. Idempotent: each call is a
 * full upsert, so removing a skill from disk and restarting the
 * server leaves a stale row — that's fine for this phase, and is the
 * trigger we'd hook a "remove skills not on disk" sweep into later.
 */
export function loadBuiltinSkills(): void {
  let dirs: string[];
  try {
    dirs = readdirSync(BUILTIN_DIR);
  } catch (err) {
    console.warn(
      `[skills] no builtin skills directory at ${BUILTIN_DIR} (${(err as Error).message})`,
    );
    return;
  }

  for (const id of dirs) {
    const skillDir = join(BUILTIN_DIR, id);
    if (!statSync(skillDir).isDirectory()) continue;

    const skillMdPath = join(skillDir, SKILL_MD);
    let skillMd: string;
    try {
      skillMd = readFileSync(skillMdPath, "utf8");
    } catch {
      console.warn(`[skills] ${id}: missing SKILL.md, skipping`);
      continue;
    }

    const fm = parseFrontmatter(skillMd);
    const name = fm.name ?? id;
    const description = fm.description ?? null;
    const version = fm.version ?? "0.1.0";

    upsertSkill({
      id,
      layer: BUILTIN_LAYER,
      name,
      description,
      version,
      is_managed: true,
    });

    for (const rel of walk(skillDir, skillDir)) {
      const full = join(skillDir, rel);
      const content = readFileSync(full);
      putSkillFile(id, rel, new Uint8Array(content), mimeFor(rel));
    }
  }

  console.log(`[skills] loaded ${dirs.length} builtin skill(s) from disk`);
}
