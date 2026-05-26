import {
  existsSync,
  mkdirSync,
  readdirSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";

const DB_PATH = process.env.DB_PATH || join(process.cwd(), "runway.db");
const SOURCES_DIR =
  process.env.SOURCES_DIR || join(dirname(DB_PATH), "sources");

/**
 * How many source snapshots to keep per app. Mirrors the image-retention
 * window so source and image history line up for rollback. Tarballs are
 * the post-ignore file set, so they are small; 10 is a comfortable default.
 */
export const SOURCE_RETENTION = Math.max(
  parseInt(process.env.RUNWAY_SOURCE_RETENTION ?? "", 10) || 10,
  1
);

function ensureDir() {
  if (!existsSync(SOURCES_DIR)) {
    mkdirSync(SOURCES_DIR, { recursive: true });
  }
}

function safeId(appId: string): string {
  // App ids are already lowercase alphanumerics (see createApp), but
  // sanitise anyway so a stray id can never escape SOURCES_DIR.
  return appId.replace(/[^a-z0-9-]/gi, "-").toLowerCase();
}

/**
 * Legacy single-file path used before per-deploy history existed. Still
 * read as a fallback so apps last deployed on an older Runway keep working
 * until their next deploy populates a per-deploy snapshot.
 */
export function legacySourcePath(appId: string): string {
  return join(SOURCES_DIR, `${safeId(appId)}.tar`);
}

export function sourcePathForDeploy(appId: string, deployId: number): string {
  return join(SOURCES_DIR, `${safeId(appId)}-${deployId}.tar`);
}

export interface SourceRef {
  path: string;
  /** null for the legacy single-file source (deploy id unknown). */
  deployId: number | null;
  bytes: number;
  mtime: Date;
}

/**
 * Deploy ids that have a saved source snapshot, most recent first.
 */
export function listSourceDeployIds(appId: string): number[] {
  if (!existsSync(SOURCES_DIR)) return [];
  const prefix = `${safeId(appId)}-`;
  const ids: number[] = [];
  for (const name of readdirSync(SOURCES_DIR)) {
    if (!name.startsWith(prefix) || !name.endsWith(".tar")) continue;
    const middle = name.slice(prefix.length, -".tar".length);
    if (/^\d+$/.test(middle)) ids.push(parseInt(middle, 10));
  }
  return ids.sort((a, b) => b - a);
}

function toRef(path: string, deployId: number | null): SourceRef | null {
  if (!existsSync(path)) return null;
  const s = statSync(path);
  return { path, deployId, bytes: s.size, mtime: s.mtime };
}

/**
 * Resolve the source for a specific deploy, or null if not retained.
 */
export function sourceForDeploy(
  appId: string,
  deployId: number
): SourceRef | null {
  return toRef(sourcePathForDeploy(appId, deployId), deployId);
}

/**
 * Resolve the most recent saved source: the highest per-deploy snapshot,
 * falling back to the legacy single file, else null.
 */
export function latestSource(appId: string): SourceRef | null {
  const [newest] = listSourceDeployIds(appId);
  if (newest !== undefined) {
    const ref = sourceForDeploy(appId, newest);
    if (ref) return ref;
  }
  return toRef(legacySourcePath(appId), null);
}

/** True if any source (per-deploy or legacy) exists for the app. */
export function hasAnySource(appId: string): boolean {
  return latestSource(appId) !== null;
}

/** True if a snapshot exists for this specific deploy. */
export function hasSourceForDeploy(appId: string, deployId: number): boolean {
  return existsSync(sourcePathForDeploy(appId, deployId));
}

/**
 * Persist a deploy's build context so the project source can be pulled back
 * to a fresh working directory. Writes atomically (tmp + rename) so a crash
 * mid-write never leaves a torn file in place of a previous good source.
 */
export function saveSource(appId: string, deployId: number, tar: Buffer): void {
  ensureDir();
  const final = sourcePathForDeploy(appId, deployId);
  const tmp = `${final}.tmp`;
  writeFileSync(tmp, tar);
  renameSync(tmp, final);
}

/**
 * Pure: given deploy ids (any order) and a keep-count, return the ids whose
 * snapshots should be pruned (oldest beyond the keep window).
 */
export function pickSourcesToPrune(deployIds: number[], keep: number): number[] {
  return [...deployIds].sort((a, b) => b - a).slice(Math.max(keep, 0));
}

/**
 * Delete per-deploy snapshots beyond the retention window. Best-effort.
 */
export function pruneOldSources(appId: string, keep = SOURCE_RETENTION): void {
  for (const id of pickSourcesToPrune(listSourceDeployIds(appId), keep)) {
    try {
      unlinkSync(sourcePathForDeploy(appId, id));
    } catch {
      // best effort
    }
  }
}

/**
 * Remove every saved source for an app (per-deploy snapshots + legacy file).
 * Called when an app is destroyed.
 */
export function deleteAllSources(appId: string): void {
  for (const id of listSourceDeployIds(appId)) {
    try {
      unlinkSync(sourcePathForDeploy(appId, id));
    } catch {
      // best effort
    }
  }
  const legacy = legacySourcePath(appId);
  if (existsSync(legacy)) {
    try {
      unlinkSync(legacy);
    } catch {
      // best effort
    }
  }
}
