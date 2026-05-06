import { createHash } from "node:crypto";

/**
 * Curated-skill import: pull a skill bundle out of a public GitHub
 * repo, validate it has a SKILL.md with name+description frontmatter,
 * and return the file blobs ready for storage in `skill_files`.
 *
 * "Signing" is implemented as a hardcoded whitelist of reputable
 * publishers — there is no cryptographic signature on the agent
 * skills format itself. A bundle from a whitelisted org is recorded
 * as `signed=1`; everything else lands as `signed=0` and the admin
 * has to opt in explicitly. The SHA-256 of the bundle is stored on
 * the skill row so a silent upstream change shows up on re-import.
 */

const TRUSTED_ORGS = new Set<string>([
  "anthropics",
  "vercel-labs",
  "microsoft",
  "tech-leads-club",
  "stripe",
  "cloudflare",
  "netlify",
  "figma",
  "google",
  "google-labs",
  "sentry",
  "expo",
  "huggingface",
]);

export function listTrustedOrgs(): string[] {
  return [...TRUSTED_ORGS].sort();
}

export function isTrustedSource(owner: string): boolean {
  return TRUSTED_ORGS.has(owner.toLowerCase());
}

export interface ParsedSource {
  owner: string;
  repo: string;
  /** Path inside the repo. Empty string means repo root. */
  path: string;
  /** Branch or ref. Defaults to "main" when not parsed from a URL. */
  ref: string;
}

/**
 * Accept any of:
 *   anthropics/skills/pdf
 *   anthropics/skills
 *   https://github.com/anthropics/skills
 *   https://github.com/anthropics/skills/tree/main/pdf
 *   https://github.com/anthropics/skills/tree/develop/sub/dir
 */
export function parseSkillSource(input: string): ParsedSource | null {
  let s = input.trim();
  if (!s) return null;

  let ref = "main";
  s = s.replace(/^https?:\/\/github\.com\//, "");
  const treeMatch = s.match(/^([^/]+)\/([^/]+)\/tree\/([^/]+)\/?(.*)$/);
  if (treeMatch) {
    return {
      owner: treeMatch[1]!,
      repo: treeMatch[2]!,
      ref: treeMatch[3]!,
      path: (treeMatch[4] ?? "").replace(/\/$/, ""),
    };
  }

  s = s.replace(/\/$/, "");
  const parts = s.split("/").filter(Boolean);
  if (parts.length < 2) return null;
  const [owner, repo, ...rest] = parts;
  return {
    owner: owner!,
    repo: repo!,
    ref,
    path: rest.join("/"),
  };
}

export interface FetchedFile {
  /** Path relative to the skill root (e.g. "SKILL.md", "scripts/run.sh"). */
  path: string;
  content: Uint8Array;
}

const MAX_FILES = 100;
const MAX_FILE_BYTES = 1 * 1024 * 1024;
const MAX_TOTAL_BYTES = 5 * 1024 * 1024;

interface GitHubEntry {
  name: string;
  path: string;
  type: "file" | "dir" | string;
  size: number;
  download_url: string | null;
}

async function ghJson(url: string): Promise<unknown> {
  const res = await fetch(url, {
    headers: {
      Accept: "application/vnd.github+json",
      "User-Agent": "runway-skills-importer",
    },
  });
  if (res.status === 404) throw new Error(`GitHub 404: ${url}`);
  if (res.status === 403) throw new Error(`GitHub rate-limited or forbidden`);
  if (!res.ok) throw new Error(`GitHub responded ${res.status}`);
  return res.json();
}

/**
 * Recursively fetch every file under `src.path` in the repo. Returns
 * paths normalised to be relative to the skill root, so a bundle at
 * `anthropics/skills/pdf` produces `SKILL.md`, `scripts/run.sh`, etc.
 *
 * Hard limits per bundle: 100 files, 1 MB per file, 5 MB total. These
 * exist to bound the work and the stored blob size — anything larger
 * is almost certainly the wrong directory.
 */
export async function fetchSkillBundle(
  src: ParsedSource,
): Promise<FetchedFile[]> {
  const files: FetchedFile[] = [];
  let totalBytes = 0;
  const rootPrefix = src.path ? src.path + "/" : "";

  async function walk(currentPath: string): Promise<void> {
    const url = `https://api.github.com/repos/${src.owner}/${src.repo}/contents/${currentPath}?ref=${encodeURIComponent(src.ref)}`;
    const body = await ghJson(url);
    if (!Array.isArray(body)) {
      throw new Error(`expected directory at ${currentPath || "/"}`);
    }
    for (const entry of body as GitHubEntry[]) {
      if (files.length >= MAX_FILES) {
        throw new Error(`bundle has more than ${MAX_FILES} files`);
      }
      if (entry.type === "dir") {
        await walk(entry.path);
        continue;
      }
      if (entry.type !== "file" || !entry.download_url) continue;
      if (entry.size > MAX_FILE_BYTES) {
        throw new Error(`file ${entry.path} exceeds ${MAX_FILE_BYTES} bytes`);
      }
      const fileRes = await fetch(entry.download_url, {
        headers: { "User-Agent": "runway-skills-importer" },
      });
      if (!fileRes.ok) {
        throw new Error(`could not download ${entry.path} (${fileRes.status})`);
      }
      const buf = new Uint8Array(await fileRes.arrayBuffer());
      totalBytes += buf.length;
      if (totalBytes > MAX_TOTAL_BYTES) {
        throw new Error(`bundle exceeds ${MAX_TOTAL_BYTES} bytes total`);
      }
      const rel = entry.path.startsWith(rootPrefix)
        ? entry.path.slice(rootPrefix.length)
        : entry.path;
      files.push({ path: rel, content: buf });
    }
  }

  await walk(src.path);

  if (!files.some((f) => f.path === "SKILL.md")) {
    throw new Error("bundle has no SKILL.md at the root of the path");
  }
  return files;
}

/**
 * Stable hash of the bundle content. Files are sorted by path and
 * concatenated as `path\0content\0` so a renamed file changes the
 * hash even when its bytes are identical.
 */
export function bundleSha256(files: FetchedFile[]): string {
  const hash = createHash("sha256");
  const sorted = [...files].sort((a, b) => a.path.localeCompare(b.path));
  for (const f of sorted) {
    hash.update(f.path);
    hash.update(Buffer.from([0]));
    hash.update(f.content);
    hash.update(Buffer.from([0]));
  }
  return hash.digest("hex");
}

export function mimeForPath(path: string): string {
  if (path.endsWith(".md")) return "text/markdown";
  if (path.endsWith(".txt")) return "text/plain";
  if (path.endsWith(".json")) return "application/json";
  if (path.endsWith(".yaml") || path.endsWith(".yml"))
    return "application/yaml";
  if (path.endsWith(".sh")) return "text/x-shellscript";
  if (path.endsWith(".py")) return "text/x-python";
  if (path.endsWith(".ts")) return "text/x-typescript";
  if (path.endsWith(".js")) return "text/javascript";
  if (path.endsWith(".dockerfile") || path.endsWith("Dockerfile"))
    return "text/x-dockerfile";
  if (path.endsWith(".png")) return "image/png";
  if (path.endsWith(".svg")) return "image/svg+xml";
  return "application/octet-stream";
}

export function sourceUrl(src: ParsedSource): string {
  const tail = src.path ? `/tree/${src.ref}/${src.path}` : "";
  return `https://github.com/${src.owner}/${src.repo}${tail}`;
}
