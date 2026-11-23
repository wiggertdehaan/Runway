import { readFileSync, existsSync, statSync } from "node:fs";
import { readdir, readlink } from "node:fs/promises";
import { createRequire } from "node:module";
import { join, relative, sep } from "node:path";
import { create as createTar } from "tar";

// `ignore` ships CommonJS typings that trip up Node16 module resolution,
// so load it through createRequire instead of a static ESM import.
const require = createRequire(import.meta.url);
type IgnoreInstance = {
  add(pattern: string | string[]): IgnoreInstance;
  ignores(path: string): boolean;
};
const ignoreFactory = require("ignore") as () => IgnoreInstance;

/**
 * True when a symlink at `relPath` (relative to the project root, `/`
 * separated) with target `target` stays inside the project: not absolute,
 * and a leading run of `..` no deeper than the folder it sits in. `..` after
 * a real segment is refused (if that segment is itself a link, the real path
 * goes elsewhere). Mirrors the server-side check in control (deploy/safe-tar),
 * which would reject the whole upload for such a link.
 */
export function isSafeLinkTarget(relPath: string, target: string): boolean {
  if (target.length === 0 || target.includes("\0")) return false;
  if (target.startsWith("/") || target.startsWith("\\") || /^[a-zA-Z]:[\\/]/.test(target)) {
    return false;
  }
  const parts = target.split(/[\\/]/).filter((p) => p !== "" && p !== ".");
  let leading = 0;
  while (leading < parts.length && parts[leading] === "..") leading += 1;
  if (parts.slice(leading).includes("..")) return false;
  const folderDepth = Math.max(relPath.split("/").filter(Boolean).length - 1, 0);
  return leading <= folderDepth;
}

/**
 * Walk a directory and return every file path that survives the
 * ignore filters. Paths are returned relative to `root` and use
 * forward-slash separators so they can be fed directly to `tar`.
 */
async function collectFiles(root: string, ig: IgnoreInstance, skippedLinks: string[]) {
  const results: string[] = [];

  async function walk(dir: string) {
    const entries = await readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const full = join(dir, entry.name);
      const rel = relative(root, full).split(sep).join("/");
      if (!rel) continue;

      // ignore() expects directories to end with a slash
      const candidate = entry.isDirectory() ? `${rel}/` : rel;
      if (ig.ignores(candidate)) continue;

      if (entry.isDirectory()) {
        await walk(full);
      } else if (entry.isSymbolicLink()) {
        // A link that points out of the project (or is absolute) would make
        // the server refuse the whole upload; leave it out and say so.
        let target = "";
        try {
          target = await readlink(full);
        } catch {
          /* unreadable link: treat as unsafe */
        }
        if (isSafeLinkTarget(rel, target)) results.push(rel);
        else skippedLinks.push(rel);
      } else if (entry.isFile()) {
        results.push(rel);
      }
    }
  }

  await walk(root);
  return results;
}

function loadIgnore(root: string): IgnoreInstance {
  const ig = ignoreFactory();

  // Always ignore the git directory and common noise
  ig.add([
    ".git",
    ".git/**",
    "node_modules",
    "node_modules/**",
    ".DS_Store",
    "Thumbs.db",
  ]);

  const dockerignore = join(root, ".dockerignore");
  if (existsSync(dockerignore)) {
    ig.add(readFileSync(dockerignore, "utf8"));
  }

  const gitignore = join(root, ".gitignore");
  if (existsSync(gitignore)) {
    ig.add(readFileSync(gitignore, "utf8"));
  }

  // Force-include the two files the build itself needs. A generated
  // .dockerignore excludes Dockerfile and .dockerignore so they never
  // land in a static webroot, but buildctl reads the Dockerfile from a
  // separate --local dockerfile mount and .dockerignore from the context
  // root, so both must still reach the server in the tarball.
  ig.add(["!Dockerfile", "!.dockerignore"]);

  return ig;
}

/** Default upload limit, the same as the server's default (Settings > max upload). */
const DEFAULT_MAX_UPLOAD_MB = 100;

/** Upload limit in bytes: RUNWAY_MAX_UPLOAD_MB if set to a positive number, else 100 MB. */
export function maxUploadBytes(env: NodeJS.ProcessEnv = process.env): number {
  const mb = parseInt(env.RUNWAY_MAX_UPLOAD_MB ?? "", 10);
  return (Number.isFinite(mb) && mb > 0 ? mb : DEFAULT_MAX_UPLOAD_MB) * 1024 * 1024;
}

export class UploadTooLargeLocalError extends Error {
  constructor(limitBytes: number) {
    const mb = Math.round(limitBytes / (1024 * 1024));
    super(
      `The project is larger than the upload limit of ${mb} MB. ` +
        `Add big folders to .dockerignore, or ask the Runway admin to raise ` +
        `"max upload" in Settings and set RUNWAY_MAX_UPLOAD_MB to match.`
    );
    this.name = "UploadTooLargeLocalError";
  }
}

export interface TarResult {
  buffer: Buffer;
  fileCount: number;
  /** Symlinks left out because they point outside the project. */
  skippedLinks: string[];
}

/**
 * Tar the project directory into a single in-memory Buffer suitable
 * for upload to the Runway deploy endpoint. Honors .dockerignore and
 * .gitignore. Stops early (UploadTooLargeLocalError) once the tar would
 * exceed the upload limit, and leaves out symlinks that point outside
 * the project (reported in `skippedLinks`).
 */
export async function tarProjectDetailed(
  root: string,
  limitBytes: number = maxUploadBytes()
): Promise<TarResult> {
  if (!existsSync(root) || !statSync(root).isDirectory()) {
    throw new Error(`Project root not found: ${root}`);
  }

  const ig = loadIgnore(root);
  const skippedLinks: string[] = [];
  const files = await collectFiles(root, ig, skippedLinks);

  if (files.length === 0) {
    throw new Error("No files to upload (everything was ignored).");
  }

  const stream = createTar(
    {
      cwd: root,
      gzip: false,
      portable: true,
      prefix: "",
    },
    files
  ) as unknown as NodeJS.ReadableStream;

  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of stream) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buf.length;
    if (size > limitBytes) {
      (stream as unknown as { destroy?: () => void }).destroy?.();
      throw new UploadTooLargeLocalError(limitBytes);
    }
    chunks.push(buf);
  }
  return { buffer: Buffer.concat(chunks), fileCount: files.length, skippedLinks };
}

/** Same as tarProjectDetailed, returning only the tar. */
export async function tarProject(root: string): Promise<Buffer> {
  return (await tarProjectDetailed(root)).buffer;
}

export interface TarSummary {
  fileCount: number;
  byteSize: number;
}

export function summarizeTar(buffer: Buffer, fileCount: number): TarSummary {
  return {
    fileCount,
    byteSize: buffer.length,
  };
}
