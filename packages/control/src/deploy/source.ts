import {
  createReadStream,
  existsSync,
  mkdirSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import type { Readable } from "node:stream";

const DB_PATH = process.env.DB_PATH || join(process.cwd(), "runway.db");
const SOURCES_DIR =
  process.env.SOURCES_DIR || join(dirname(DB_PATH), "sources");

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

export function sourcePath(appId: string): string {
  return join(SOURCES_DIR, `${safeId(appId)}.tar`);
}

export function sourceExists(appId: string): boolean {
  return existsSync(sourcePath(appId));
}

export function sourceStat(appId: string): { bytes: number; mtime: Date } | null {
  const path = sourcePath(appId);
  if (!existsSync(path)) return null;
  const s = statSync(path);
  return { bytes: s.size, mtime: s.mtime };
}

/**
 * Persist the latest deploy tar so the project source can be pulled
 * back to a fresh working directory. Writes atomically (tmp + rename)
 * so a crash mid-write never leaves a torn file in place of the
 * previous good source.
 */
export function saveSource(appId: string, tar: Buffer): void {
  ensureDir();
  const final = sourcePath(appId);
  const tmp = `${final}.tmp`;
  writeFileSync(tmp, tar);
  renameSync(tmp, final);
}

export function openSourceStream(appId: string): Readable {
  return createReadStream(sourcePath(appId));
}

export function deleteSource(appId: string): void {
  const path = sourcePath(appId);
  if (existsSync(path)) {
    try {
      unlinkSync(path);
    } catch {
      // best effort
    }
  }
}
