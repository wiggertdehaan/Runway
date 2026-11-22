/**
 * Dependency auto-update, pure half: decide which vulnerable application
 * packages a rebuild should raise, and rewrite the manifests that pin
 * them. No disk, no network, no database: dep-apply.ts does the I/O.
 *
 * A plain rebuild only refreshes the base image. A vulnerability in a
 * package the app itself asks for (pillow, nodemailer) survives it,
 * because the manifest or lockfile keeps selecting the same version.
 */
import { kevFindings } from "./kev.js";
import type { Finding } from "./scan.js";

export type Ecosystem = "python" | "node";

/** "compatible": stays within the installed major. "major": crosses it. */
export type DepKind = "compatible" | "major";

export interface DepUpdate {
  ecosystem: Ecosystem;
  /** Package name as the scanner reported it. */
  name: string;
  /** Version found in the running image. */
  from: string;
  /** Lowest version that fixes the targeted findings. */
  to: string;
  kind: DepKind;
  /** Finding ids this update is expected to remove. */
  cves: string[];
}

export interface DepSkip {
  ecosystem: Ecosystem;
  name: string;
  reason: string;
}

export interface DepPlan {
  compatible: DepUpdate[];
  major: DepUpdate[];
  skipped: DepSkip[];
}

const PYTHON_TYPES = new Set(["python-pkg", "pip", "pipenv", "poetry", "uv", "conda-pkg"]);
const NODE_TYPES = new Set(["node-pkg", "npm", "yarn", "pnpm", "bun"]);

/**
 * Which ecosystem a finding belongs to, or null for OS packages and
 * anything we cannot update through a manifest. Node modules that ship
 * inside the base image (npm's own dependencies under lib/node_modules)
 * are not the app's: no package.json edit reaches them.
 */
export function ecosystemOf(f: Finding): Ecosystem | null {
  if (f.source !== "image" || !f.pkgType) return null;
  if (PYTHON_TYPES.has(f.pkgType)) return "python";
  if (NODE_TYPES.has(f.pkgType)) {
    if (f.pkgPath && /(^|\/)lib\/node_modules\//.test(f.pkgPath)) return null;
    return "node";
  }
  return null;
}

/** PEP 503 name normalisation; harmless for npm names. */
export function normalizeName(ecosystem: Ecosystem, name: string): string {
  return ecosystem === "python" ? name.toLowerCase().replace(/[-_.]+/g, "-") : name;
}

/** Key used to remember a failed attempt: "python:pillow@13.0.0". */
export function depKey(u: Pick<DepUpdate, "ecosystem" | "name" | "to">): string {
  return `${u.ecosystem}:${normalizeName(u.ecosystem, u.name)}@${u.to}`;
}

/**
 * Plain release versions only ("1.2.3", "v2.0", "70.3.0.1"). Anything
 * with a pre-release, epoch or local part returns null: we do not guess
 * how those order, we skip the package.
 */
export function parseVersion(v: string): number[] | null {
  const m = /^v?(\d+(?:\.\d+){0,4})$/.exec(v.trim());
  if (!m) return null;
  return m[1].split(".").map((n) => parseInt(n, 10));
}

export function compareVersions(a: number[], b: number[]): number {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const d = (a[i] ?? 0) - (b[i] ?? 0);
    if (d !== 0) return d < 0 ? -1 : 1;
  }
  return 0;
}

/**
 * Same release line? Same major; for 0.x the minor counts as the major,
 * as in semver, because 0.x releases break on minor bumps.
 */
export function sameLine(a: number[], b: number[]): boolean {
  if (a[0] !== b[0]) return false;
  return a[0] === 0 ? (a[1] ?? 0) === (b[1] ?? 0) : true;
}

/**
 * Pick the version to move to for one finding. `fixed` may list one fix
 * per maintained line ("2.4.0, 1.20.9"). The lowest fix on the installed
 * line wins; without one, the lowest fix above the installed version.
 */
export function chooseFix(
  installed: string,
  fixed: string
): { version: string; kind: DepKind } | null {
  const cur = parseVersion(installed);
  if (!cur) return null;
  const candidates = fixed
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => ({ s: s.replace(/^v/, ""), v: parseVersion(s) }))
    .filter((c): c is { s: string; v: number[] } => c.v !== null && compareVersions(c.v, cur) > 0)
    .sort((a, b) => compareVersions(a.v, b.v));
  if (candidates.length === 0) return null;
  const same = candidates.find((c) => sameLine(c.v, cur));
  if (same) return { version: same.s, kind: "compatible" };
  return { version: candidates[0].s, kind: "major" };
}

export interface PlanOptions {
  /** depKey()s that failed recently and should not be retried yet. */
  skip?: Set<string>;
}

/**
 * Pure: from the scan of the running image, which packages to raise.
 * Targets are findings with a published fix that are actively exploited
 * (KEV), CRITICAL or HIGH. A package can get a compatible step and a
 * major step: the compatible one fixes what it can within the installed
 * line, the major one is tried afterwards, on its own.
 */
export function planDepUpdates(
  findings: Finding[],
  kev: Set<string>,
  opts: PlanOptions = {}
): DepPlan {
  const plan: DepPlan = { compatible: [], major: [], skipped: [] };
  const kevIds = new Set(kevFindings(findings, kev).map((f) => f.id.toUpperCase()));

  const groups = new Map<string, { ecosystem: Ecosystem; name: string; items: Finding[] }>();
  for (const f of findings) {
    const ecosystem = ecosystemOf(f);
    if (!ecosystem || !f.pkg || !f.version || !f.fixedVersion) continue;
    const wanted =
      f.severity === "CRITICAL" || f.severity === "HIGH" || kevIds.has(f.id.toUpperCase());
    if (!wanted) continue;
    const key = `${ecosystem}:${normalizeName(ecosystem, f.pkg)}`;
    const g = groups.get(key) ?? { ecosystem, name: f.pkg, items: [] };
    g.items.push(f);
    groups.set(key, g);
  }

  for (const g of [...groups.values()].sort((a, b) => a.name.localeCompare(b.name))) {
    // Several copies of one package can be installed (nested node_modules).
    // Plan from the lowest installed version so the target covers them all.
    const versions = [...new Set(g.items.map((f) => f.version!))];
    const parsed = versions
      .map((s) => ({ s, v: parseVersion(s) }))
      .filter((x): x is { s: string; v: number[] } => x.v !== null)
      .sort((a, b) => compareVersions(a.v, b.v));
    if (parsed.length === 0) {
      plan.skipped.push({ ecosystem: g.ecosystem, name: g.name, reason: `cannot read version "${versions[0]}"` });
      continue;
    }
    const from = parsed[0].s;

    type Slot = { to: string; cves: Set<string> };
    let compatible: Slot | null = null;
    let major: Slot | null = null;
    let unreadable = 0;
    for (const f of g.items) {
      const choice = chooseFix(f.version!, f.fixedVersion!);
      if (!choice) {
        unreadable++;
        continue;
      }
      const slot: Slot | null = choice.kind === "compatible" ? compatible : major;
      const next: Slot = slot ?? { to: choice.version, cves: new Set<string>() };
      if (compareVersions(parseVersion(choice.version)!, parseVersion(next.to)!) > 0) {
        next.to = choice.version;
      }
      next.cves.add(f.id.toUpperCase());
      if (choice.kind === "compatible") compatible = next;
      else major = next;
    }
    if (!compatible && !major) {
      if (unreadable > 0) {
        plan.skipped.push({ ecosystem: g.ecosystem, name: g.name, reason: "no usable fixed version" });
      }
      continue;
    }
    for (const [kind, slot] of [["compatible", compatible], ["major", major]] as const) {
      if (!slot) continue;
      const u: DepUpdate = {
        ecosystem: g.ecosystem,
        name: g.name,
        from,
        to: slot.to,
        kind,
        cves: [...slot.cves].sort(),
      };
      if (opts.skip?.has(depKey(u))) {
        plan.skipped.push({
          ecosystem: g.ecosystem,
          name: g.name,
          reason: `${u.to} failed recently; not retried yet`,
        });
        continue;
      }
      plan[kind].push(u);
    }
  }
  return plan;
}

// ── Python: requirements files ────────────────────────────────────

const REQ_LINE =
  /^(\s*)([A-Za-z0-9][A-Za-z0-9._-]*)(\s*\[[^\]]*\])?([^;#]*?)(\s*;[^#]*?)?(\s+#.*)?$/;
const CLAUSE = /(===|==|~=|!=|<=|>=|<|>)\s*([^\s,]+)/g;

/**
 * The new version specifier for a requirement that must reach `to`. An
 * exact pin stays an exact pin. Otherwise the floor becomes `>=to`, and
 * an upper bound is kept only while it still allows `to` (so
 * `>=2.31,<3.0` to 2.32.4 keeps `<3.0`, but `<13.0` to 13.0.0 loses it).
 */
export function raiseSpecifier(spec: string, to: string): string {
  const target = parseVersion(to);
  const clauses = [...spec.matchAll(CLAUSE)].map((m) => ({ op: m[1], ver: m[2] }));
  if (clauses.length === 1 && (clauses[0].op === "==" || clauses[0].op === "===") && !clauses[0].ver.includes("*")) {
    return `==${to}`;
  }
  const keep: string[] = [];
  for (const c of clauses) {
    if (c.op !== "<" && c.op !== "<=" && c.op !== "!=") continue;
    const v = parseVersion(c.ver);
    if (!v || !target) continue;
    const cmp = compareVersions(target, v);
    const ok = c.op === "<" ? cmp < 0 : c.op === "<=" ? cmp <= 0 : cmp !== 0;
    if (ok) keep.push(`${c.op}${c.ver}`);
  }
  return [`>=${to}`, ...keep].join(",");
}

export interface RewriteResult {
  text: string;
  applied: string[];
  skipped: Array<{ name: string; reason: string }>;
}

/** True when the file pins hashes: any edit would break `--require-hashes`. */
export function requirementsAreHashPinned(text: string): boolean {
  return /(^|\s)--hash[=\s]/m.test(text);
}

/** Does this requirements file name the package at all? */
export function requirementsMention(text: string, name: string): boolean {
  const want = normalizeName("python", name);
  return text.split(/\r?\n/).some((line) => {
    const m = REQ_LINE.exec(line);
    return !!m && !line.trim().startsWith("-") && normalizeName("python", m[2]) === want;
  });
}

/**
 * Raise packages in a requirements file. A package that is listed gets
 * its specifier raised in place; one that is not listed (a transitive
 * dependency, or one that came with the base image) is appended, which
 * is how pip is told about a floor for something you do not ask for
 * directly. `appendMissing` is off for files that are not the one pip
 * installs from.
 */
export function rewriteRequirements(
  text: string,
  updates: Array<Pick<DepUpdate, "name" | "to">>,
  appendMissing = true
): RewriteResult {
  const out: RewriteResult = { text, applied: [], skipped: [] };
  if (requirementsAreHashPinned(text)) {
    for (const u of updates) out.skipped.push({ name: u.name, reason: "requirements file pins hashes" });
    return out;
  }
  const eol = text.includes("\r\n") ? "\r\n" : "\n";
  const lines = text.split(/\r?\n/);
  const pending = new Map(updates.map((u) => [normalizeName("python", u.name), u]));

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#") || trimmed.startsWith("-")) continue;
    const m = REQ_LINE.exec(line);
    if (!m) continue;
    const u = pending.get(normalizeName("python", m[2]));
    if (!u) continue;
    const spec = m[4] ?? "";
    if (/@|:\/\//.test(spec)) {
      out.skipped.push({ name: u.name, reason: "installed from a URL, not a version" });
      pending.delete(normalizeName("python", m[2]));
      continue;
    }
    lines[i] = `${m[1]}${m[2]}${m[3] ?? ""}${raiseSpecifier(spec, u.to)}${m[5] ?? ""}${m[6] ?? ""}`;
    out.applied.push(u.name);
    pending.delete(normalizeName("python", m[2]));
  }

  if (pending.size > 0) {
    if (appendMissing) {
      while (lines.length > 0 && lines[lines.length - 1].trim() === "") lines.pop();
      lines.push("# Added by Runway: minimum versions that fix known vulnerabilities.");
      for (const u of pending.values()) {
        lines.push(`${u.name}>=${u.to}`);
        out.applied.push(u.name);
      }
      lines.push("");
    } else {
      for (const u of pending.values()) out.skipped.push({ name: u.name, reason: "not listed in a requirements file" });
    }
  }
  out.text = lines.join(eol);
  return out;
}

// ── Node: package.json ────────────────────────────────────────────

/** A spec npm resolves from the registry by version: "^1.2.3", "~1", "1.x", ">=1 <2", "*", "latest". */
function isRegistryRange(spec: string): boolean {
  return /^[\^~<>=\s\d.xX*|-]+$/.test(spec) || /^[a-z][a-z0-9-]*$/.test(spec);
}

function detectIndent(text: string): string | number {
  const m = /^\{\r?\n([ \t]+)"/.exec(text);
  return m ? m[1] : 2;
}

/**
 * Raise packages in package.json. A direct dependency gets its range set
 * to `^to`. A transitive one is forced through `overrides`, which is how
 * npm lets you set a floor for a package you do not depend on directly.
 * The lockfile is not touched here; it is regenerated afterwards.
 */
export function rewritePackageJson(
  text: string,
  updates: Array<Pick<DepUpdate, "name" | "to">>
): RewriteResult {
  const out: RewriteResult = { text, applied: [], skipped: [] };
  let pkg: Record<string, any>;
  try {
    pkg = JSON.parse(text);
  } catch {
    for (const u of updates) out.skipped.push({ name: u.name, reason: "package.json is not valid JSON" });
    return out;
  }
  if (typeof pkg !== "object" || pkg === null || Array.isArray(pkg)) {
    for (const u of updates) out.skipped.push({ name: u.name, reason: "package.json is not an object" });
    return out;
  }
  const sections = ["dependencies", "optionalDependencies", "devDependencies"] as const;

  for (const u of updates) {
    const range = `^${u.to}`;
    let direct = false;
    let blocked: string | null = null;
    for (const s of sections) {
      const deps = pkg[s];
      if (!deps || typeof deps !== "object" || !(u.name in deps)) continue;
      direct = true;
      if (typeof deps[u.name] !== "string" || !isRegistryRange(deps[u.name])) {
        blocked = "not installed from the npm registry by version";
        break;
      }
      deps[u.name] = range;
    }
    if (blocked) {
      out.skipped.push({ name: u.name, reason: blocked });
      continue;
    }
    if (!direct) {
      if (pkg.overrides === undefined) pkg.overrides = {};
      if (typeof pkg.overrides !== "object" || pkg.overrides === null || Array.isArray(pkg.overrides)) {
        out.skipped.push({ name: u.name, reason: "package.json has an unusual overrides field" });
        continue;
      }
      const existing = pkg.overrides[u.name];
      if (existing !== undefined && typeof existing !== "string") {
        out.skipped.push({ name: u.name, reason: "package.json already has a nested override for it" });
        continue;
      }
      pkg.overrides[u.name] = range;
    }
    out.applied.push(u.name);
  }
  if (out.applied.length > 0) {
    out.text = JSON.stringify(pkg, null, detectIndent(text)) + (text.endsWith("\n") ? "\n" : "");
  }
  return out;
}

// ── Wording ───────────────────────────────────────────────────────

export function describeUpdate(u: Pick<DepUpdate, "name" | "from" | "to" | "kind">): string {
  return `${u.name} ${u.from} → ${u.to}${u.kind === "major" ? " (major)" : ""}`;
}
