/**
 * Dependency auto-update, I/O half: write planned updates into a copy of
 * the app's source tar.
 *
 * Safety rules, because the tar is untrusted and control runs as root:
 * - The tar is never unpacked as a tree. Members are listed, a manifest
 *   is read with `tar -xO`, and the edited file replaces that one member.
 * - Only regular-file members are read or replaced (no symlinks or
 *   hardlinks), so nothing is ever written through a link.
 * - npm never runs in the control container. A lockfile is regenerated
 *   in a throwaway BuildKit build, the same sandbox every app build uses.
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { parseDockerfile } from "./base-images.js";
import {
  requirementsMention,
  rewritePackageJson,
  rewriteRequirements,
  type DepUpdate,
} from "./dep-updates.js";

const MAX_MANIFEST_BYTES = 5 * 1024 * 1024;
const TAR_ENV = { ...process.env, LC_ALL: "C", TZ: "UTC" };

export interface TarMember {
  /** Name exactly as stored ("./requirements.txt" or "requirements.txt"). */
  name: string;
  /** Name without a leading "./". */
  path: string;
  /** True for a regular file. */
  regular: boolean;
}

/** Pure: parse `tar -tvf` output. */
export function parseTarListing(listing: string): TarMember[] {
  const out: TarMember[] = [];
  for (const line of listing.split("\n")) {
    const m = /^(\S)\S*\s+\S+\s+\d+\s+\S+\s+\S+\s+(.*)$/.exec(line);
    if (!m) continue;
    const type = m[1];
    let name = m[2];
    if (type === "l") name = name.split(" -> ")[0];
    if (type === "h") name = name.split(" link to ")[0];
    out.push({ name, path: name.replace(/^(\.\/)+/, ""), regular: type === "-" });
  }
  return out;
}

const REQ_FILE = /(^|\/)requirements[^/]*\.txt$/i;
const VENDORED = /(^|\/)(node_modules|\.venv|venv|env|site-packages|vendor|\.git)\//;

/** Pure: requirements files worth considering, shallowest first. */
export function requirementFiles(members: TarMember[]): TarMember[] {
  return members
    .filter((m) => m.regular && REQ_FILE.test(m.path) && !VENDORED.test(m.path))
    .filter((m) => m.path.split("/").length <= 3)
    .sort((a, b) => a.path.split("/").length - b.path.split("/").length || a.path.localeCompare(b.path));
}

/** Pure: requirements files a Dockerfile installs from (`pip install -r x`). */
export function requirementsInDockerfile(dockerfile: string | null): string[] {
  if (!dockerfile) return [];
  const names: string[] = [];
  for (const m of dockerfile.matchAll(/(?:-r|--requirement)[=\s]+["']?([^\s"'\\]+)/g)) {
    names.push(m[1].replace(/^.*\//, ""));
  }
  return names;
}

/** Pure: the Node image the app builds with, for regenerating its lockfile. */
export function nodeImageOf(dockerfile: string | null): string {
  if (dockerfile) {
    for (const from of parseDockerfile(dockerfile).froms) {
      const ref = from.resolved ?? "";
      if (/^(docker\.io\/)?(library\/)?node:[A-Za-z0-9._-]+$/.test(ref)) return ref;
    }
  }
  return "node:24-alpine";
}

export interface LockSyncInput {
  appId: string;
  nodeImage: string;
  packageJson: string;
  packageLock: string;
  npmrc: string | null;
}
/** Returns the regenerated package-lock.json. Injected (docker / tests). */
export type LockSync = (input: LockSyncInput) => Promise<string>;

export interface ApplyOptions {
  appId: string;
  dockerfile: string | null;
  lockSync: LockSync;
}

export interface ApplyResult {
  /** The patched tar, or the input when nothing could be applied. */
  tar: Buffer;
  applied: DepUpdate[];
  skipped: Array<{ update: DepUpdate; reason: string }>;
  /** Members that were replaced. */
  files: string[];
}

function tarRun(args: string[], maxBuffer = 64 * 1024 * 1024): Buffer {
  return execFileSync("tar", args, { env: TAR_ENV, maxBuffer, stdio: ["ignore", "pipe", "ignore"] });
}

/**
 * Apply updates to a copy of the tar. Never throws for an update it
 * cannot place (that becomes a skip); throws only when the tar itself
 * cannot be handled, and the caller then builds the source as it is.
 */
export async function applyDepUpdates(
  tar: Buffer,
  updates: DepUpdate[],
  opts: ApplyOptions
): Promise<ApplyResult> {
  const result: ApplyResult = { tar, applied: [], skipped: [], files: [] };
  if (updates.length === 0) return result;
  const skip = (us: DepUpdate[], reason: string) => {
    for (const update of us) result.skipped.push({ update, reason });
  };

  const dir = mkdtempSync(join(tmpdir(), "runway-deps-"));
  try {
    const tarPath = join(dir, "ctx.tar");
    writeFileSync(tarPath, tar);
    const members = parseTarListing(tarRun(["-tvf", tarPath]).toString("utf8"));
    const byPath = new Map<string, TarMember[]>();
    for (const m of members) byPath.set(m.path, [...(byPath.get(m.path) ?? []), m]);
    /** The member for a path, only when it is one regular file. */
    const regular = (path: string): TarMember | null => {
      const all = byPath.get(path) ?? [];
      return all.length === 1 && all[0].regular ? all[0] : null;
    };
    const read = (m: TarMember): string => {
      const buf = tarRun(["-xOf", tarPath, m.name], MAX_MANIFEST_BYTES);
      return buf.toString("utf8");
    };
    const replacements = new Map<TarMember, string>();

    // ── Python ──
    const py = updates.filter((u) => u.ecosystem === "python");
    if (py.length > 0) {
      const files = requirementFiles(members).filter((m) => regular(m.path));
      if (files.length === 0) {
        skip(py, "no requirements.txt in the source (pyproject / Pipfile are not supported yet)");
      } else {
        const texts = new Map(files.map((m) => [m, read(m)]));
        const installed = requirementsInDockerfile(opts.dockerfile);
        const home =
          files.find((m) => installed.includes(m.path.replace(/^.*\//, ""))) ??
          files.find((m) => m.path === "requirements.txt") ??
          (files.length === 1 ? files[0] : null);
        const perFile = new Map<TarMember, DepUpdate[]>();
        for (const u of py) {
          const target = files.find((m) => requirementsMention(texts.get(m)!, u.name)) ?? home;
          if (!target) {
            skip([u], "several requirements files and none lists it");
            continue;
          }
          perFile.set(target, [...(perFile.get(target) ?? []), u]);
        }
        for (const [m, us] of perFile) {
          const r = rewriteRequirements(texts.get(m)!, us);
          for (const s of r.skipped) skip(us.filter((u) => u.name === s.name), s.reason);
          const done = us.filter((u) => r.applied.includes(u.name));
          if (done.length > 0 && r.text !== texts.get(m)) {
            replacements.set(m, r.text);
            result.applied.push(...done);
          }
        }
      }
    }

    // ── Node ──
    const node = updates.filter((u) => u.ecosystem === "node");
    if (node.length > 0) {
      const pkgMember = regular("package.json");
      const lockMember = regular("package-lock.json");
      const foreign = ["yarn.lock", "pnpm-lock.yaml", "bun.lockb", "bun.lock", "npm-shrinkwrap.json"].find((f) =>
        byPath.has(f)
      );
      if (!pkgMember) {
        skip(node, "no package.json at the top of the source");
      } else if (foreign) {
        skip(node, `${foreign} is not supported yet (npm lockfiles only)`);
      } else if (byPath.has("package-lock.json") && !lockMember) {
        skip(node, "package-lock.json is not a regular file");
      } else {
        const r = rewritePackageJson(read(pkgMember), node);
        for (const s of r.skipped) skip(node.filter((u) => u.name === s.name), s.reason);
        const done = node.filter((u) => r.applied.includes(u.name));
        if (done.length > 0) {
          let lock: string | null = null;
          let failed: string | null = null;
          if (lockMember) {
            const npmrcMember = regular(".npmrc");
            try {
              lock = await opts.lockSync({
                appId: opts.appId,
                nodeImage: nodeImageOf(opts.dockerfile),
                packageJson: r.text,
                packageLock: read(lockMember),
                npmrc: npmrcMember ? read(npmrcMember) : null,
              });
              JSON.parse(lock);
            } catch (err: any) {
              failed = `could not regenerate package-lock.json: ${err?.message ?? err}`;
            }
          }
          if (failed) {
            skip(done, failed);
          } else {
            replacements.set(pkgMember, r.text);
            if (lockMember && lock !== null) replacements.set(lockMember, lock);
            result.applied.push(...done);
          }
        }
      }
    }

    if (replacements.size === 0) return result;

    // Replace the members: drop the old entry, append the new file under
    // the same stored name. A new file has a new mtime, which BuildKit's
    // context sync needs to notice a same-length change.
    const stage = join(dir, "stage");
    for (const [m, text] of replacements) {
      const target = join(stage, m.name);
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, text);
      tarRun(["--delete", "-f", tarPath, m.name]);
      tarRun(["-rf", tarPath, "--owner=0", "--group=0", "-C", stage, m.name]);
      result.files.push(m.path);
    }
    result.tar = readFileSync(tarPath);
    return result;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Dockerfile of the throwaway build that regenerates a lockfile. */
export function lockSyncDockerfile(nodeImage: string): string {
  return [
    `FROM ${nodeImage} AS sync`,
    "WORKDIR /w",
    "COPY . .",
    "RUN npm install --package-lock-only --ignore-scripts --no-audit --no-fund",
    "FROM scratch",
    "COPY --from=sync /w/package-lock.json /package-lock.json",
    "",
  ].join("\n");
}

/**
 * Regenerate package-lock.json for an edited package.json inside
 * BuildKit: build a two-file context, then lift the lockfile out of the
 * resulting (scratch) image. Nothing from the app's source runs: only
 * the two manifests are in the context and npm runs with
 * --ignore-scripts.
 */
export const lockSyncViaBuildKit: LockSync = async (input) => {
  const { buildImageFromTar, readFileFromImage, removeImageByTag } = await import("./docker.js");
  const dir = mkdtempSync(join(tmpdir(), "runway-locksync-"));
  const imageTag = `runway-locksync-${input.appId.toLowerCase().replace(/[^a-z0-9-]/g, "-")}:t${Date.now().toString(36)}`;
  try {
    const ctx = join(dir, "ctx");
    mkdirSync(ctx);
    writeFileSync(join(ctx, "package.json"), input.packageJson);
    writeFileSync(join(ctx, "package-lock.json"), input.packageLock);
    if (input.npmrc !== null) writeFileSync(join(ctx, ".npmrc"), input.npmrc);
    writeFileSync(join(ctx, "Dockerfile"), lockSyncDockerfile(input.nodeImage));
    const tarPath = join(dir, "ctx.tar");
    tarRun(["-cf", tarPath, "-C", ctx, "."]);
    await buildImageFromTar(readFileSync(tarPath), { imageTag });
    const lock = await readFileFromImage(imageTag, "/package-lock.json", MAX_MANIFEST_BYTES * 4);
    return lock.toString("utf8");
  } finally {
    rmSync(dir, { recursive: true, force: true });
    await removeImageByTag(imageTag).catch(() => {});
  }
};
