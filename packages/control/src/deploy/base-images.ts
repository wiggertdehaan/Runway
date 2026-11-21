/**
 * Base-image patch planning for rebuilds.
 *
 * A Dockerfile that pins `FROM nginx:1.30.6-alpine` can never pick up
 * the CVE fix in 1.30.7-alpine, so a rebuild "from the same source"
 * keeps shipping the vulnerable base. For rebuilds we therefore build
 * from a build-time copy of the Dockerfile in which an *exact patch
 * pin* is bumped to the newest patch of the same major.minor and the
 * same variant. The owner's stored source is never modified.
 *
 * Rules (deliberately conservative):
 *  - only `x.y.z` / `x.y.z-variant` tags are touched (optional `v`);
 *  - never a different major or minor, never a different variant;
 *  - digest pins (`@sha256:`) and floating tags (`1.30`, `24-alpine`,
 *    `latest`, no tag) are left alone;
 *  - stage references (`FROM build`) and `scratch` are not images;
 *  - pre-release variants (rc/alpha/beta...) are never bumped.
 *
 * Everything in this file is pure; registry access lives in
 * registry.ts and is injected via `TagSource`.
 */

export interface ImageRef {
  /** Registry host, e.g. "docker.io", "ghcr.io". */
  registry: string;
  /** Repository path, e.g. "library/nginx". */
  repo: string;
  tag: string | null;
  digest: string | null;
}

/** Parse `[registry/]repo[:tag][@digest]`. Returns null if unusable. */
export function parseImageRef(raw: string): ImageRef | null {
  let rest = raw.trim();
  if (!rest || /\s/.test(rest)) return null;
  let digest: string | null = null;
  const at = rest.indexOf("@");
  if (at >= 0) {
    digest = rest.slice(at + 1);
    rest = rest.slice(0, at);
    if (!/^[a-z0-9]+:[0-9a-fA-F]{32,}$/.test(digest)) return null;
  }
  let tag: string | null = null;
  const lastSlash = rest.lastIndexOf("/");
  const colon = rest.lastIndexOf(":");
  if (colon > lastSlash) {
    tag = rest.slice(colon + 1);
    rest = rest.slice(0, colon);
    if (!tag) return null;
  }
  const parts = rest.split("/");
  let registry = "docker.io";
  if (
    parts.length > 1 &&
    (parts[0].includes(".") || parts[0].includes(":") || parts[0] === "localhost")
  ) {
    registry = parts.shift()!.toLowerCase();
  }
  if (registry === "index.docker.io" || registry === "registry-1.docker.io") {
    registry = "docker.io";
  }
  let repo = parts.join("/");
  if (!repo) return null;
  if (registry === "docker.io" && !repo.includes("/")) repo = `library/${repo}`;
  return { registry, repo, tag, digest };
}

export interface ExactTag {
  prefix: string; // "" or "v"
  major: number;
  minor: number;
  patch: number;
  /** Everything after the first "-" (e.g. "alpine", "slim-bookworm"), "" if none. */
  variant: string;
}

const EXACT_TAG = /^(v?)(\d+)\.(\d+)\.(\d+)(?:-(.+))?$/;
const PRERELEASE_VARIANT = /^(rc|alpha|beta|pre|preview|dev|snapshot|nightly|edge|test)/i;

/**
 * Classify a tag: an exact patch pin returns its parts; anything else
 * (floating, minor-only, latest, 4-part versions, pre-releases) null.
 */
export function parseExactTag(tag: string): ExactTag | null {
  // Valid Docker tag charset only: a tag from a registry is later written
  // into a Dockerfile copy / build-arg, so newlines etc. must never pass.
  if (!/^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$/.test(tag)) return null;
  const m = EXACT_TAG.exec(tag);
  if (!m) return null;
  const variant = m[5] ?? "";
  if (variant && PRERELEASE_VARIANT.test(variant)) return null;
  // "1.30.6.1-alpine": the "-" rule above already rejects 4-part
  // versions because the 4th number would land in the regex tail.
  return {
    prefix: m[1],
    major: parseInt(m[2], 10),
    minor: parseInt(m[3], 10),
    patch: parseInt(m[4], 10),
    variant,
  };
}

/**
 * Pick the newest patch tag within the same major.minor and variant,
 * strictly newer than `current`. Returns null when there is none.
 */
export function pickLatestPatch(
  current: ExactTag,
  availableTags: string[]
): string | null {
  let best: { patch: number; tag: string } | null = null;
  for (const tag of availableTags) {
    const t = parseExactTag(tag);
    if (!t) continue;
    if (
      t.prefix !== current.prefix ||
      t.major !== current.major ||
      t.minor !== current.minor ||
      t.variant !== current.variant ||
      t.patch <= current.patch
    ) {
      continue;
    }
    if (!best || t.patch > best.patch) best = { patch: t.patch, tag };
  }
  return best?.tag ?? null;
}

// ── Escalation: newer minor / major lines ─────────────────────────

/** How a tag pins its version. */
export type PinStyle = "exact" | "minor" | "major";

export interface VersionTag {
  style: PinStyle;
  prefix: string;
  major: number;
  /** undefined for major-only tags (`24-alpine`). */
  minor?: number;
  patch?: number;
  variant: string;
}

const MINOR_TAG = /^(v?)(\d+)\.(\d+)(?:-(.+))?$/;
const MAJOR_TAG = /^(v?)(\d+)(?:-(.+))?$/;

/** Classify any tag as exact / minor / major pin, or null (latest, names...). */
export function parseVersionTag(tag: string): VersionTag | null {
  if (!/^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$/.test(tag)) return null;
  const e = parseExactTag(tag);
  if (e) return { style: "exact", ...e };
  const m = MINOR_TAG.exec(tag);
  if (m) {
    const variant = m[4] ?? "";
    if (variant && PRERELEASE_VARIANT.test(variant)) return null;
    return { style: "minor", prefix: m[1], major: +m[2], minor: +m[3], variant };
  }
  const j = MAJOR_TAG.exec(tag);
  if (j) {
    const variant = j[3] ?? "";
    if (variant && PRERELEASE_VARIANT.test(variant)) return null;
    return { style: "major", prefix: j[1], major: +j[2], variant };
  }
  return null;
}

/**
 * Candidate tags in NEWER MINOR lines of the same major and variant,
 * lowest minor first, at most `limit`. The tag style follows the
 * current pin: an exact pin gets the newest patch of each newer minor
 * (`1.31.9-alpine`), a minor pin gets the minor tag (`1.31-alpine`).
 * Major-only pins (`node:24`) have no minor to escalate.
 */
export function pickMinorCandidates(
  current: VersionTag,
  availableTags: string[],
  limit = 3
): string[] {
  if (current.style === "major" || current.minor === undefined) return [];
  const byMinor = new Map<number, { patch: number; tag: string }>();
  for (const tag of availableTags) {
    const t = parseVersionTag(tag);
    if (!t || t.style !== current.style) continue;
    if (t.prefix !== current.prefix || t.major !== current.major || t.variant !== current.variant) continue;
    if (t.minor === undefined || t.minor <= current.minor) continue;
    const patch = t.patch ?? 0;
    const prev = byMinor.get(t.minor);
    if (!prev || patch > prev.patch) byMinor.set(t.minor, { patch, tag });
  }
  return [...byMinor.entries()]
    .sort(([a], [b]) => a - b)
    .slice(0, limit)
    .map(([, v]) => v.tag);
}

/**
 * The tag to PROBE in the next major line (never applied automatically):
 * the lowest newer major that exists for this variant, in the same
 * pin style, newest version within it.
 */
export function pickMajorProbe(
  current: VersionTag,
  availableTags: string[]
): string | null {
  const higher = new Map<number, { key: number[]; tag: string }>();
  for (const tag of availableTags) {
    const t = parseVersionTag(tag);
    if (!t || t.style !== current.style) continue;
    if (t.prefix !== current.prefix || t.variant !== current.variant || t.major <= current.major) continue;
    const key = [t.minor ?? 0, t.patch ?? 0];
    const prev = higher.get(t.major);
    if (!prev || key[0] > prev.key[0] || (key[0] === prev.key[0] && key[1] > prev.key[1])) {
      higher.set(t.major, { key, tag });
    }
  }
  const lowest = [...higher.keys()].sort((a, b) => a - b)[0];
  return lowest === undefined ? null : higher.get(lowest)!.tag;
}

/** "1.30" for 1.30.7-alpine / 1.30-alpine; "24" for 24-alpine; null otherwise. */
export function lineOf(tag: string): string | null {
  const t = parseVersionTag(tag);
  if (!t) return null;
  return t.minor !== undefined ? `${t.major}.${t.minor}` : `${t.major}`;
}

// ── Dockerfile parsing ────────────────────────────────────────────

export interface FromInstruction {
  /** 0-based physical line index holding the image token. */
  line: number;
  /** The image token exactly as written (may contain $VARS). */
  raw: string;
  /** `raw` after ARG expansion, or null if it could not be resolved. */
  resolved: string | null;
  stage: string | null;
}

export interface StageInfo {
  /** Index into ParsedDockerfile.froms when this stage's base is an external image, else null. */
  fromIndex: number | null;
  /** Index into `stages` when the base is an earlier stage, else null. */
  baseStage: number | null;
  scratch: boolean;
}

export interface ParsedDockerfile {
  /** Every FROM, in order, resolved to external image vs earlier stage. */
  stages: StageInfo[];
  froms: FromInstruction[];
  /** Global ARG defaults declared before the first FROM. */
  args: Record<string, string | undefined>;
  /** Names declared by a global `ARG`, with or without default. */
  declaredArgs: Set<string>;
}

/** Collapse backslash continuations, keeping the first physical line index. */
function logicalLines(text: string): Array<{ line: number; text: string }> {
  const physical = text.split(/\r?\n/);
  const out: Array<{ line: number; text: string }> = [];
  let i = 0;
  while (i < physical.length) {
    const start = i;
    let buf = "";
    for (;;) {
      const piece = physical[i] ?? "";
      i++;
      // comment lines inside a continuation are dropped by Docker
      if (buf !== "" && /^\s*#/.test(piece)) {
        if (i >= physical.length) break;
        continue;
      }
      const trimmedEnd = piece.replace(/\s+$/, "");
      if (trimmedEnd.endsWith("\\")) {
        buf += trimmedEnd.slice(0, -1) + " ";
        if (i >= physical.length) break;
        continue;
      }
      buf += piece;
      break;
    }
    out.push({ line: start, text: buf });
  }
  return out;
}

function unquote(v: string): string {
  const t = v.trim();
  if (t.length >= 2 && ((t[0] === '"' && t.at(-1) === '"') || (t[0] === "'" && t.at(-1) === "'"))) {
    return t.slice(1, -1);
  }
  return t;
}

/**
 * Expand $VAR, ${VAR}, ${VAR:-d}, ${VAR-d} using global ARG defaults.
 * Returns null on anything we don't model (e.g. ${VAR:+x}) or an unset
 * variable without a default.
 */
export function expandArgs(
  input: string,
  args: Record<string, string | undefined>
): string | null {
  let failed = false;
  const out = input.replace(
    /\$\{([A-Za-z_][A-Za-z0-9_]*)(?:(:?[-+?=])([^}]*))?\}|\$([A-Za-z_][A-Za-z0-9_]*)/g,
    (_m, name1, op, word, name2) => {
      const name = (name1 ?? name2) as string;
      const val = args[name];
      if (op === undefined || op === null) {
        if (val === undefined) failed = true;
        return val ?? "";
      }
      if (op === ":-" || op === "-") {
        const unset = op === ":-" ? val === undefined || val === "" : val === undefined;
        return unset ? (word as string) : (val as string);
      }
      failed = true; // :+ :? := not modelled
      return "";
    }
  );
  return failed ? null : out;
}

export function parseDockerfile(text: string): ParsedDockerfile {
  const args: Record<string, string | undefined> = {};
  const declaredArgs = new Set<string>();
  const froms: FromInstruction[] = [];
  const stages: StageInfo[] = [];
  const stageNames = new Map<string, number>();
  let seenFrom = false;

  for (const { line, text: l } of logicalLines(text)) {
    const trimmed = l.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;

    if (!seenFrom) {
      const arg = /^ARG\s+([A-Za-z_][A-Za-z0-9_]*)(?:=(.*))?$/i.exec(trimmed);
      if (arg) {
        declaredArgs.add(arg[1]);
        args[arg[1]] = arg[2] !== undefined ? unquote(arg[2]) : undefined;
        continue;
      }
    }

    const from = /^FROM\s+((?:--\S+\s+)*)(\S+)(?:\s+AS\s+(\S+))?\s*$/i.exec(trimmed);
    if (!from) continue;
    seenFrom = true;
    const raw = from[2];
    const stage = from[3] ?? null;

    const refIdx = stageNames.get(raw.toLowerCase());
    const isStageRef = refIdx !== undefined;
    const scratch = raw.toLowerCase() === "scratch";
    const stageIndex = stages.length;
    if (stage) stageNames.set(stage.toLowerCase(), stageIndex);
    if (isStageRef || scratch) {
      stages.push({ fromIndex: null, baseStage: isStageRef ? refIdx! : null, scratch });
      continue;
    }
    stages.push({ fromIndex: froms.length, baseStage: null, scratch: false });

    froms.push({
      line,
      raw,
      resolved: raw.includes("$") ? expandArgs(raw, args) : raw,
      stage,
    });
  }
  return { stages, froms, args, declaredArgs };
}

/**
 * The external FROM that provides the RUNTIME (final) stage: the last
 * stage, following `FROM <earlier-stage>` chains back to an image.
 * Packages in earlier build stages never reach the final image, so only
 * this base matters for runtime vulnerabilities. Null for `scratch`.
 */
export function findRuntimeFrom(parsed: ParsedDockerfile): FromInstruction | null {
  let i = parsed.stages.length - 1;
  for (let guard = 0; i >= 0 && guard < 64; guard++) {
    const st = parsed.stages[i];
    if (st.fromIndex !== null) return parsed.froms[st.fromIndex] ?? null;
    if (st.baseStage === null) return null; // scratch
    i = st.baseStage;
  }
  return null;
}

// ── Planning ──────────────────────────────────────────────────────

/**
 * Lists available tags of a repository. Injected (registry.ts / tests).
 * `filter` is a tag prefix hint (e.g. "1." for everything in major 1); by
 * default the source narrows to the ref's own major.minor line.
 */
export type TagSource = (
  ref: ImageRef,
  opts?: { filter?: string }
) => Promise<string[]>;

export type BumpKind = "patch" | "minor" | "major";

export interface BasePatch {
  /** Image as written/resolved before patching, e.g. "nginx:1.30.6-alpine". */
  from: string;
  /** Same image with the bumped tag, e.g. "nginx:1.30.7-alpine". */
  to: string;
  /** "patch" (default), "minor" (escalation) or "major" (dry-run probe only). */
  kind?: BumpKind;
}

export interface BaseSkip {
  ref: string;
  reason: string;
}

export interface BasePlan {
  /** Rewritten Dockerfile text, or undefined when nothing changed textually. */
  dockerfile?: string;
  /** Build-args overriding ARG-driven FROM refs. */
  buildArgs: Record<string, string>;
  patches: BasePatch[];
  skipped: BaseSkip[];
}

function withTag(resolved: string, newTag: string): string {
  // resolved has no digest here (digest refs are skipped earlier).
  const lastSlash = resolved.lastIndexOf("/");
  const colon = resolved.lastIndexOf(":");
  const base = colon > lastSlash ? resolved.slice(0, colon) : resolved;
  return `${base}:${newTag}`;
}

/**
 * Decide which FROM refs get a patch bump and how to apply it:
 * literal refs are rewritten in the Dockerfile copy; refs driven by a
 * single global ARG are overridden with a build-arg instead.
 */
export interface PlanOptions {
  /**
   * Force one specific FROM (by its physical line) to a given tag instead
   * of the normal "newest patch" rule. Used for minor escalation and the
   * major probe; every other FROM still gets its normal patch bump.
   */
  retarget?: { line: number; tag: string; kind: BumpKind };
}

export async function planBasePatches(
  dockerfileText: string,
  tagSource: TagSource,
  opts: PlanOptions = {}
): Promise<BasePlan> {
  const parsed = parseDockerfile(dockerfileText);
  const lines = dockerfileText.split(/\r?\n/);
  const skipped: BaseSkip[] = [];

  // Each accepted bump, with how it will be applied.
  interface Planned {
    patch: BasePatch;
    literal?: { line: number; raw: string };
    arg?: { name: string; value: string };
  }
  const planned: Planned[] = [];

  for (const f of parsed.froms) {
    if (f.resolved === null) {
      skipped.push({ ref: f.raw, reason: "cannot resolve ARG in FROM" });
      continue;
    }
    const ref = parseImageRef(f.resolved);
    if (!ref) {
      skipped.push({ ref: f.raw, reason: "unparseable image reference" });
      continue;
    }
    if (ref.digest) {
      skipped.push({ ref: f.resolved, reason: "digest-pinned" });
      continue;
    }
    if (!ref.tag) {
      skipped.push({ ref: f.resolved, reason: "floating (no tag)" });
      continue;
    }
    const forced = opts.retarget && opts.retarget.line === f.line ? opts.retarget : null;
    let newTag: string | null;
    if (forced) {
      if (!parseVersionTag(ref.tag)) {
        skipped.push({ ref: f.resolved, reason: "runtime base is not a versioned tag" });
        continue;
      }
      newTag = forced.tag;
    } else {
      const exact = parseExactTag(ref.tag);
      if (!exact) {
        skipped.push({ ref: f.resolved, reason: "not an exact patch pin" });
        continue;
      }
      let available: string[];
      try {
        available = await tagSource(ref);
      } catch (err) {
        skipped.push({
          ref: f.resolved,
          reason: `registry lookup failed: ${(err as Error).message}`,
        });
        continue;
      }
      newTag = pickLatestPatch(exact, available);
      if (!newTag) {
        skipped.push({ ref: f.resolved, reason: "already on the newest patch" });
        continue;
      }
    }
    const patch: BasePatch = {
      from: f.resolved,
      to: withTag(f.resolved, newTag),
      ...(forced ? { kind: forced.kind } : {}),
    };

    if (!f.raw.includes("$")) {
      if (!lines[f.line]?.includes(f.raw)) {
        skipped.push({ ref: f.raw, reason: "FROM spans several lines" });
        continue;
      }
      planned.push({ patch, literal: { line: f.line, raw: f.raw } });
      continue;
    }

    // ARG-driven FROM: only the two clean shapes are supported.
    const tagVar = /^[^$]+:(?:\$\{([A-Za-z_]\w*)(?::?-[^}]*)?\}|\$([A-Za-z_]\w*))$/.exec(f.raw);
    const wholeVar = /^(?:\$\{([A-Za-z_]\w*)(?::?-[^}]*)?\}|\$([A-Za-z_]\w*))$/.exec(f.raw);
    let arg: { name: string; value: string } | undefined;
    if (tagVar) arg = { name: tagVar[1] ?? tagVar[2], value: newTag };
    else if (wholeVar) arg = { name: wholeVar[1] ?? wholeVar[2], value: patch.to };
    if (!arg) {
      skipped.push({ ref: f.raw, reason: "ARG used in a shape we don't rewrite" });
      continue;
    }
    if (!parsed.declaredArgs.has(arg.name)) {
      skipped.push({ ref: f.raw, reason: `ARG ${arg.name} is not declared before FROM` });
      continue;
    }
    planned.push({ patch, arg });
  }

  // One build-arg can only carry one value: if two FROMs want different
  // values for the same ARG, override neither.
  const valuesByArg = new Map<string, Set<string>>();
  for (const p of planned) {
    if (!p.arg) continue;
    const set = valuesByArg.get(p.arg.name) ?? new Set<string>();
    set.add(p.arg.value);
    valuesByArg.set(p.arg.name, set);
  }
  const accepted: Planned[] = [];
  for (const p of planned) {
    if (p.arg && (valuesByArg.get(p.arg.name)?.size ?? 0) > 1) {
      skipped.push({
        ref: p.patch.from,
        reason: `ARG ${p.arg.name} would need two different values`,
      });
      continue;
    }
    accepted.push(p);
  }

  const buildArgs: Record<string, string> = {};
  const edited = new Map<number, string>();
  for (const p of accepted) {
    if (p.arg) buildArgs[p.arg.name] = p.arg.value;
    if (p.literal) {
      const cur = edited.get(p.literal.line) ?? lines[p.literal.line];
      edited.set(p.literal.line, cur.replace(p.literal.raw, p.patch.to));
    }
  }
  let dockerfile: string | undefined;
  if (edited.size > 0) {
    for (const [idx, line] of edited) lines[idx] = line;
    dockerfile = lines.join(dockerfileText.includes("\r\n") ? "\r\n" : "\n");
  }
  return { dockerfile, buildArgs, patches: accepted.map((p) => p.patch), skipped };
}

// ── What was actually used ────────────────────────────────────────

export interface UsedBaseImage {
  /** Image reference as built, e.g. "docker.io/library/nginx:1.30.7-alpine". */
  image: string;
  digest: string;
  /** Tag it was automatically raised from, if this build patched it. */
  auto_patched_from?: string;
  /** Minor line it was escalated from ("1.30"), if this build jumped minors. */
  auto_minor_from?: string;
}

/**
 * Extract the base images (tag + digest) BuildKit actually used from
 * its plain-progress log, e.g.
 *   #5 [1/4] FROM docker.io/library/nginx:1.30.7-alpine@sha256:ab12...
 * The log is authoritative: it reflects what was really resolved.
 */
export function extractUsedBaseImages(
  buildLog: string,
  patches: BasePatch[] = []
): UsedBaseImage[] {
  const seen = new Set<string>();
  const out: UsedBaseImage[] = [];
  const re = /\]\s+FROM\s+(\S+?)@(sha256:[0-9a-f]{64})/g;
  for (const m of buildLog.matchAll(re)) {
    const key = `${m[1]}@${m[2]}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const used: UsedBaseImage = { image: m[1], digest: m[2] };
    const hit = patches.find((p) => sameImage(m[1], p.to));
    if (hit) {
      const fromTag = tagOf(hit.from) ?? hit.from;
      if (hit.kind === "minor") used.auto_minor_from = lineOf(fromTag) ?? fromTag;
      else used.auto_patched_from = fromTag;
    }
    out.push(used);
  }
  return out;
}

function tagOf(ref: string): string | null {
  return parseImageRef(ref)?.tag ?? null;
}

function sameImage(a: string, b: string): boolean {
  const ra = parseImageRef(a);
  const rb = parseImageRef(b);
  return !!ra && !!rb && ra.registry === rb.registry && ra.repo === rb.repo && ra.tag === rb.tag;
}

/** One-line human form: "nginx:1.30.7-alpine @ab12cd34 (auto-patched from 1.30.6-alpine)". */
export function describeBaseImage(b: UsedBaseImage): string {
  const short = b.image.replace(/^docker\.io\/(library\/)?/, "");
  const dg = b.digest.replace(/^sha256:/, "").slice(0, 12);
  const toLine = lineOf(parseImageRef(b.image)?.tag ?? "") ?? "?";
  const note = b.auto_minor_from
    ? ` (auto-minor ${b.auto_minor_from}→${toLine})`
    : b.auto_patched_from
      ? ` (auto-patched from ${b.auto_patched_from})`
      : "";
  return `${short} @${dg}${note}`;
}
