/**
 * Safe handling of an uploaded build-context tar (S06).
 *
 * The upload is untrusted: a tar can name files outside the folder it is
 * unpacked into (absolute paths, `..`), carry symlinks and hardlinks that
 * point out of it (and are then written through), device nodes, millions
 * of entries or a few huge ones. Control used to unpack it with
 * `sh -c "tar xf ..."` as root, synchronously.
 *
 * Now: one streaming pass (`inspectTarFile`) checks every entry against
 * the limits below before anything touches the disk, and the unpack
 * (`extractTarSafe`) runs the same predicate again as a filter, in-process
 * with the `tar` library (no shell, no argument strings), asynchronously,
 * with ownership forced to `nobody` instead of whatever the archive says.
 *
 * Pure checks live in `checkEntry` so they can be tested without a tar.
 */
import { createReadStream } from "node:fs";
import { mkdir, open } from "node:fs/promises";
import { Parser, extract } from "tar";

export type UnsafeTarCode =
  | "compressed"
  | "path"
  | "link"
  | "type"
  | "entries"
  | "size"
  | "corrupt";

export class UnsafeTarError extends Error {
  readonly code: UnsafeTarCode;
  constructor(code: UnsafeTarCode, message: string) {
    super(message);
    this.name = "UnsafeTarError";
    this.code = code;
  }
}

export interface TarLimits {
  /** Sum of all file sizes in the archive. */
  maxBytes: number;
  maxEntries: number;
  maxPathLength: number;
  maxDepth: number;
}

export interface TarStats {
  entries: number;
  bytes: number;
}

const DEFAULT_MAX_ENTRIES = 100_000;
const DEFAULT_MAX_PATH = 1024;
const DEFAULT_MAX_DEPTH = 128;

function envInt(name: string, fallback: number): number {
  const n = parseInt(process.env[name] ?? "", 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

/** Limits for one upload; `maxBytes` is the deploy upload limit. */
export function tarLimits(maxBytes: number): TarLimits {
  return {
    maxBytes,
    maxEntries: envInt("RUNWAY_TAR_MAX_ENTRIES", DEFAULT_MAX_ENTRIES),
    maxPathLength: envInt("RUNWAY_TAR_MAX_PATH", DEFAULT_MAX_PATH),
    maxDepth: envInt("RUNWAY_TAR_MAX_DEPTH", DEFAULT_MAX_DEPTH),
  };
}

/** What an entry looks like to the checks (a subset of tar's ReadEntry). */
export interface EntryInfo {
  path: string;
  type: string;
  size: number;
  linkpath?: string;
}

const FILE_TYPES = new Set(["File", "OldFile", "ContiguousFile"]);
const ALLOWED_TYPES = new Set([...FILE_TYPES, "Directory", "SymbolicLink", "Link"]);

/** Member names are shown back to the uploader; keep them short and printable. */
function show(name: string): string {
  const clean = name.replace(/[^\x20-\x7e]/g, "?");
  return clean.length > 80 ? `${clean.slice(0, 77)}...` : clean;
}

function hasUnsafeChars(p: string): boolean {
  return p.includes("\0");
}

/** True for `/x`, `\x` and `C:\x` / `C:/x`. */
function isAbsolute(p: string): boolean {
  return p.startsWith("/") || p.startsWith("\\") || /^[a-zA-Z]:[\\/]/.test(p);
}

/** Path segments, treating `\` like `/` so a Windows-style `..\` cannot slip by. */
function segments(p: string): string[] {
  return p.split(/[\\/]/).filter((s) => s !== "" && s !== ".");
}

/**
 * Throws UnsafeTarError when the entry is not acceptable; otherwise adds it
 * to `stats`. Pure apart from `stats`.
 */
export function checkEntry(entry: EntryInfo, stats: TarStats, limits: TarLimits): void {
  const name = show(entry.path);

  stats.entries += 1;
  if (stats.entries > limits.maxEntries) {
    throw new UnsafeTarError("entries", `The archive has more than ${limits.maxEntries} entries.`);
  }

  if (!ALLOWED_TYPES.has(entry.type)) {
    throw new UnsafeTarError(
      "type",
      `"${name}" is a ${entry.type}; only files, folders and links are allowed.`,
    );
  }

  const p = entry.path;
  if (p.length === 0 || hasUnsafeChars(p)) {
    throw new UnsafeTarError("path", `An entry has an empty or invalid name.`);
  }
  if (p.length > limits.maxPathLength) {
    throw new UnsafeTarError("path", `"${name}" has a path longer than ${limits.maxPathLength} characters.`);
  }
  if (isAbsolute(p)) {
    throw new UnsafeTarError("path", `"${name}" is an absolute path.`);
  }
  const parts = segments(p);
  if (parts.includes("..")) {
    throw new UnsafeTarError("path", `"${name}" climbs out of the project folder.`);
  }
  if (parts.length > limits.maxDepth) {
    throw new UnsafeTarError("path", `"${name}" is nested deeper than ${limits.maxDepth} folders.`);
  }

  if (FILE_TYPES.has(entry.type)) {
    if (!Number.isFinite(entry.size) || entry.size < 0) {
      throw new UnsafeTarError("size", `"${name}" has an invalid size.`);
    }
    stats.bytes += entry.size;
    if (stats.bytes > limits.maxBytes) {
      throw new UnsafeTarError(
        "size",
        `The archive unpacks to more than ${Math.round(limits.maxBytes / (1024 * 1024))} MB.`,
      );
    }
  }

  if (entry.type === "SymbolicLink") checkSymlink(entry, parts, limits);
  if (entry.type === "Link") checkHardlink(entry, limits);
}

function checkSymlink(entry: EntryInfo, entryParts: string[], limits: TarLimits): void {
  const name = show(entry.path);
  const target = entry.linkpath ?? "";
  if (target.length === 0 || hasUnsafeChars(target) || target.length > limits.maxPathLength) {
    throw new UnsafeTarError("link", `The symlink "${name}" has an invalid target.`);
  }
  if (isAbsolute(target)) {
    throw new UnsafeTarError("link", `The symlink "${name}" points to an absolute path.`);
  }
  // Allowed: a run of leading `..` that stays inside the project folder.
  // Refused: `..` after a real segment (`a/../..`). Lexically that looks
  // harmless, but if `a` is itself a link the real path goes elsewhere.
  const parts = target.split(/[\\/]/).filter((s) => s !== "" && s !== ".");
  let leading = 0;
  while (leading < parts.length && parts[leading] === "..") leading += 1;
  if (parts.slice(leading).includes("..")) {
    throw new UnsafeTarError("link", `The symlink "${name}" uses ".." in the middle of its target.`);
  }
  // The link sits in a folder `entryParts.length - 1` levels below the root.
  const depthOfFolder = Math.max(entryParts.length - 1, 0);
  if (leading > depthOfFolder) {
    throw new UnsafeTarError("link", `The symlink "${name}" points outside the project folder.`);
  }
}

function checkHardlink(entry: EntryInfo, limits: TarLimits): void {
  const name = show(entry.path);
  const target = entry.linkpath ?? "";
  if (target.length === 0 || hasUnsafeChars(target) || target.length > limits.maxPathLength) {
    throw new UnsafeTarError("link", `The hard link "${name}" has an invalid target.`);
  }
  if (isAbsolute(target) || segments(target).includes("..")) {
    throw new UnsafeTarError("link", `The hard link "${name}" points outside the project folder.`);
  }
}

/** First bytes of known compressed formats. The deploy contract is a plain tar. */
async function assertPlainTar(file: string): Promise<void> {
  const fh = await open(file, "r");
  try {
    const head = Buffer.alloc(4);
    const { bytesRead } = await fh.read(head, 0, 4, 0);
    const gzip = bytesRead >= 2 && head[0] === 0x1f && head[1] === 0x8b;
    const zstd = bytesRead >= 4 && head[0] === 0x28 && head[1] === 0xb5 && head[2] === 0x2f && head[3] === 0xfd;
    if (gzip || zstd) {
      throw new UnsafeTarError(
        "compressed",
        "Upload a plain, uncompressed tar (Content-Type: application/x-tar).",
      );
    }
  } finally {
    await fh.close();
  }
}

/**
 * Read the whole archive once, as a stream, and apply `checkEntry` to every
 * entry. Nothing is written to disk. Throws UnsafeTarError for the first
 * violation or when the archive is damaged.
 */
export async function inspectTarFile(file: string, limits: TarLimits): Promise<TarStats> {
  await assertPlainTar(file);

  const stats: TarStats = { entries: 0, bytes: 0 };
  let violation: UnsafeTarError | null = null;

  await new Promise<void>((resolve, reject) => {
    const parser = new Parser({ strict: true });
    const src = createReadStream(file);
    let settled = false;
    const done = (err?: unknown) => {
      if (settled) return;
      settled = true;
      src.destroy();
      if (err) reject(err);
      else resolve();
    };

    parser.on("entry", (entry) => {
      if (violation) {
        entry.resume();
        return;
      }
      try {
        checkEntry(
          { path: entry.path, type: entry.type, size: entry.size, linkpath: entry.linkpath },
          stats,
          limits,
        );
      } catch (err) {
        violation = err as UnsafeTarError;
        // Stop reading: the rest of the archive does not matter any more.
        done(violation);
        return;
      }
      entry.resume();
    });
    parser.on("end", () => done());
    parser.on("error", (err) => done(err));
    src.on("error", (err) => done(err));
    src.pipe(parser);
  }).catch((err) => {
    if (violation) throw violation;
    if (err instanceof UnsafeTarError) throw err;
    throw new UnsafeTarError("corrupt", "The archive is empty or not a valid tar file.");
  });

  if (violation) throw violation;
  return stats;
}

/**
 * Check the archive, then unpack it into `dest` (which must exist or be
 * creatable). Files are owned by nobody:nogroup (65534) whatever the tar
 * says; entries that fail the check are never written.
 */
export async function extractTarSafe(
  file: string,
  dest: string,
  limits: TarLimits,
): Promise<TarStats> {
  const stats = await inspectTarFile(file, limits);

  // Second line of defence: the same predicate as a filter, with fresh counters.
  const seen: TarStats = { entries: 0, bytes: 0 };
  const filter = (path: string, entry: unknown): boolean => {
    const e = entry as { type: string; size: number; linkpath?: string };
    try {
      checkEntry({ path, type: e.type, size: e.size, linkpath: e.linkpath }, seen, limits);
      return true;
    } catch {
      return false;
    }
  };

  await mkdir(dest, { recursive: true });
  await extract({
    file,
    cwd: dest,
    strict: true,
    filter,
    // Never take ownership, mode escalation or timestamps blindly from the tar.
    preserveOwner: false,
    uid: 65534,
    gid: 65534,
    maxDepth: limits.maxDepth,
    unlink: true,
  });
  return stats;
}
