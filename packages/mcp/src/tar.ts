import { readFileSync, existsSync, statSync } from "node:fs";
import { readdir } from "node:fs/promises";
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
 * Walk a directory and return every file path that survives the
 * ignore filters. Paths are returned relative to `root` and use
 * forward-slash separators so they can be fed directly to `tar`.
 */
async function collectFiles(root: string, ig: IgnoreInstance) {
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
      } else if (entry.isFile() || entry.isSymbolicLink()) {
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

  return ig;
}

/**
 * Tar the project directory into a single in-memory Buffer suitable
 * for upload to the Runway deploy endpoint. Honors .dockerignore and
 * .gitignore.
 */
export async function tarProject(root: string): Promise<Buffer> {
  if (!existsSync(root) || !statSync(root).isDirectory()) {
    throw new Error(`Project root not found: ${root}`);
  }

  const ig = loadIgnore(root);
  const files = await collectFiles(root, ig);

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
  for await (const chunk of stream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
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
