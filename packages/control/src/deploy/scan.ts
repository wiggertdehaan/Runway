import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { execFileSync } from "node:child_process";

const execFileAsync = promisify(execFile);

export type Severity = "UNKNOWN" | "LOW" | "MEDIUM" | "HIGH" | "CRITICAL";
export type Threshold = "none" | "low" | "medium" | "high" | "critical";
export type ScanStatus = "passed" | "warned" | "blocked" | "skipped";
export type FindingSource = "image" | "secret" | "misconfig";

export interface Finding {
  id: string;
  severity: Severity;
  source: FindingSource;
  pkg?: string;
  version?: string;
  fixedVersion?: string;
  title?: string;
  location?: string;
}

export interface ScanCounts {
  critical: number;
  high: number;
  medium: number;
  low: number;
  unknown: number;
}

export interface ScanResult {
  status: ScanStatus;
  counts: ScanCounts;
  findings: Finding[];
  error?: string;
}

export const THRESHOLDS: Threshold[] = [
  "none",
  "low",
  "medium",
  "high",
  "critical",
];

const SEVERITY_ORDER: Record<Severity, number> = {
  UNKNOWN: 0,
  LOW: 1,
  MEDIUM: 2,
  HIGH: 3,
  CRITICAL: 4,
};

const THRESHOLD_ORDER: Record<Threshold, number> = {
  none: Number.POSITIVE_INFINITY,
  low: 1,
  medium: 2,
  high: 3,
  critical: 4,
};

const TRIVY_BIN = process.env.TRIVY_BIN || "trivy";
// BuildKit limits individual RUN logs; also keep scan run-time bounded.
const SCAN_TIMEOUT_MS = 180_000;
// 10 MB of JSON is already excessive; trivy on a small repo emits ~10-100 KB.
const MAX_OUTPUT_BYTES = 25 * 1024 * 1024;

export function trivyAvailable(): boolean {
  try {
    execFileSync(TRIVY_BIN, ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

export function emptyCounts(): ScanCounts {
  return { critical: 0, high: 0, medium: 0, low: 0, unknown: 0 };
}

function countSeverity(findings: Finding[]): ScanCounts {
  const counts = emptyCounts();
  for (const f of findings) {
    switch (f.severity) {
      case "CRITICAL": counts.critical++; break;
      case "HIGH": counts.high++; break;
      case "MEDIUM": counts.medium++; break;
      case "LOW": counts.low++; break;
      default: counts.unknown++;
    }
  }
  return counts;
}

function normalizeSeverity(raw: unknown): Severity {
  if (typeof raw !== "string") return "UNKNOWN";
  const up = raw.toUpperCase();
  if (up === "CRITICAL" || up === "HIGH" || up === "MEDIUM" || up === "LOW") {
    return up;
  }
  return "UNKNOWN";
}

interface TrivyResult {
  Target?: string;
  Class?: string;
  Vulnerabilities?: Array<{
    VulnerabilityID?: string;
    PkgName?: string;
    InstalledVersion?: string;
    FixedVersion?: string;
    Severity?: string;
    Title?: string;
  }>;
  Secrets?: Array<{
    RuleID?: string;
    Severity?: string;
    Title?: string;
    StartLine?: number;
    Match?: string;
  }>;
  Misconfigurations?: Array<{
    ID?: string;
    Severity?: string;
    Title?: string;
    Message?: string;
  }>;
}

function parseTrivyOutput(raw: string): Finding[] {
  const findings: Finding[] = [];
  if (!raw.trim()) return findings;

  let parsed: { Results?: TrivyResult[] };
  try {
    parsed = JSON.parse(raw);
  } catch {
    return findings;
  }

  for (const result of parsed.Results ?? []) {
    const target = result.Target ?? "";
    for (const v of result.Vulnerabilities ?? []) {
      findings.push({
        id: v.VulnerabilityID ?? "UNKNOWN",
        severity: normalizeSeverity(v.Severity),
        source: "image",
        pkg: v.PkgName,
        version: v.InstalledVersion,
        fixedVersion: v.FixedVersion,
        title: v.Title,
        location: target || undefined,
      });
    }
    for (const s of result.Secrets ?? []) {
      findings.push({
        id: s.RuleID ?? "SECRET",
        severity: normalizeSeverity(s.Severity),
        source: "secret",
        title: s.Title,
        location:
          target && s.StartLine ? `${target}:${s.StartLine}` : target || undefined,
      });
    }
    for (const m of result.Misconfigurations ?? []) {
      findings.push({
        id: m.ID ?? "MISCONFIG",
        severity: normalizeSeverity(m.Severity),
        source: "misconfig",
        title: m.Title ?? m.Message,
        location: target || undefined,
      });
    }
  }
  return findings;
}

async function runTrivy(args: string[]): Promise<string> {
  const { stdout } = await execFileAsync(TRIVY_BIN, args, {
    maxBuffer: MAX_OUTPUT_BYTES,
    timeout: SCAN_TIMEOUT_MS,
  });
  return stdout;
}

export async function scanSource(tarBuffer: Buffer): Promise<Finding[]> {
  const workDir = await mkdtemp(join(tmpdir(), "runway-scan-"));
  const tarPath = join(workDir, "source.tar");
  const srcDir = join(workDir, "src");
  try {
    await writeFile(tarPath, tarBuffer);
    execFileSync("sh", [
      "-c",
      `mkdir -p ${srcDir} && tar xf ${tarPath} -C ${srcDir}`,
    ]);
    const out = await runTrivy([
      "fs",
      "--scanners", "secret,misconfig",
      "--format", "json",
      "--quiet",
      "--no-progress",
      srcDir,
    ]);
    return parseTrivyOutput(out);
  } finally {
    await rm(workDir, { recursive: true, force: true }).catch(() => {});
  }
}

export async function scanImage(imageTag: string): Promise<Finding[]> {
  const out = await runTrivy([
    "image",
    "--scanners", "vuln",
    "--format", "json",
    "--quiet",
    "--no-progress",
    imageTag,
  ]);
  return parseTrivyOutput(out);
}

export function buildScanResult(
  findings: Finding[],
  threshold: Threshold
): ScanResult {
  const counts = countSeverity(findings);
  if (findings.length === 0) {
    return { status: "passed", counts, findings: [] };
  }
  const blocked = meetsThreshold(findings, threshold);
  return {
    status: blocked ? "blocked" : "warned",
    counts,
    findings,
  };
}

export function meetsThreshold(
  findings: Finding[],
  threshold: Threshold
): boolean {
  const min = THRESHOLD_ORDER[threshold];
  if (!Number.isFinite(min)) return false;
  return findings.some((f) => SEVERITY_ORDER[f.severity] >= min);
}

/**
 * Refresh the Trivy vulnerability DB without running a scan. Called
 * on a daily schedule so the DB stays fresh even when no deploys
 * happen for a while. Failures are logged but never thrown — this
 * is best-effort background maintenance.
 */
export async function refreshDb(): Promise<void> {
  if (!trivyAvailable()) return;
  try {
    await execFileAsync(TRIVY_BIN, ["image", "--download-db-only"], {
      timeout: 5 * 60 * 1000,
      env: { ...process.env, TRIVY_CACHE_DIR },
    });
  } catch (err: any) {
    console.error("Trivy DB refresh failed:", err?.message ?? err);
  }
}

export function isValidThreshold(v: unknown): v is Threshold {
  return typeof v === "string" && (THRESHOLDS as string[]).includes(v);
}

/**
 * Compute the effective threshold after applying the server-wide
 * floor. If the app is exempt the floor is ignored; otherwise the
 * stricter of the two wins (= the one with the lower numeric order).
 */
export function effectiveThreshold(
  appThreshold: Threshold,
  serverFloor: Threshold,
  exempt: boolean
): Threshold {
  if (exempt || serverFloor === "none") return appThreshold;
  const appOrder = THRESHOLD_ORDER[appThreshold];
  const floorOrder = THRESHOLD_ORDER[serverFloor];
  return appOrder <= floorOrder ? appThreshold : serverFloor;
}

// Trivy bundles the vulnerability DB in a cache dir; at runtime that's
// the named volume mounted at /root/.cache/trivy. Override via env for
// tests or dev environments.
const TRIVY_CACHE_DIR = process.env.TRIVY_CACHE_DIR || "/root/.cache/trivy";
// Trivy's public advisory DB normally refreshes every 6 hours; warn
// once the local copy is older than two full update cycles.
// Warn after 48 hours instead of 24 — the DB refreshes on every
// deploy, so quiet periods between deploys are normal and should not
// alarm users. The scheduled daily refresh (see index.ts) keeps the
// DB fresh even without deploys.
const DB_STALE_AFTER_MS = 48 * 60 * 60 * 1000;

export interface ScannerHealth {
  binary: { ok: boolean; detail: string };
  cache: { ok: boolean; detail: string };
  db: { ok: boolean; detail: string };
}

export async function getScannerHealth(): Promise<ScannerHealth> {
  const binary = await checkBinary();
  const cache = await checkCache();
  const db = await checkDb();
  return { binary, cache, db };
}

async function checkBinary(): Promise<{ ok: boolean; detail: string }> {
  try {
    const { stdout } = await execFileAsync(TRIVY_BIN, ["--version"], {
      timeout: 5_000,
    });
    const version = stdout.match(/Version:\s*([^\s]+)/)?.[1] ?? stdout.trim().split("\n")[0];
    return { ok: true, detail: `Trivy ${version ?? "installed"}` };
  } catch (err: any) {
    return {
      ok: false,
      detail: `trivy binary not executable: ${err?.message ?? err}`,
    };
  }
}

async function checkCache(): Promise<{ ok: boolean; detail: string }> {
  try {
    const s = await stat(TRIVY_CACHE_DIR);
    if (!s.isDirectory()) {
      return { ok: false, detail: `${TRIVY_CACHE_DIR} exists but is not a directory` };
    }
    // Ensure we can write to it — Trivy updates the DB in place.
    const probe = join(TRIVY_CACHE_DIR, `.healthcheck-${process.pid}`);
    await writeFile(probe, "ok");
    await rm(probe, { force: true });
    return { ok: true, detail: `Cache volume mounted and writable at ${TRIVY_CACHE_DIR}` };
  } catch (err: any) {
    return {
      ok: false,
      detail: `Cache directory unavailable: ${err?.message ?? err}`,
    };
  }
}

async function checkDb(): Promise<{ ok: boolean; detail: string }> {
  const metaPath = join(TRIVY_CACHE_DIR, "db", "metadata.json");
  try {
    const raw = await readFile(metaPath, "utf8");
    const meta = JSON.parse(raw) as {
      UpdatedAt?: string;
      DownloadedAt?: string;
      NextUpdate?: string;
    };
    // Measure when WE last pulled the DB, not when Trivy's upstream
    // CI last rebuilt it. Upstream publishing lag (Trivy's public DB
    // has been known to go 48h+ between rebuilds) would otherwise
    // raise a false alarm even when our refresh loop is working.
    // Fall back to UpdatedAt for older metadata that predates
    // DownloadedAt being populated.
    const downloadedAt = meta.DownloadedAt ? new Date(meta.DownloadedAt) : null;
    const updatedAt = meta.UpdatedAt ? new Date(meta.UpdatedAt) : null;
    const fresh =
      downloadedAt && !Number.isNaN(downloadedAt.getTime())
        ? downloadedAt
        : updatedAt && !Number.isNaN(updatedAt.getTime())
          ? updatedAt
          : null;
    if (!fresh) {
      return {
        ok: false,
        detail: "DB metadata has no valid DownloadedAt / UpdatedAt timestamp",
      };
    }
    const ageMs = Date.now() - fresh.getTime();
    const ageHours = Math.floor(ageMs / (60 * 60 * 1000));
    const upstreamHours = updatedAt
      ? Math.floor((Date.now() - updatedAt.getTime()) / (60 * 60 * 1000))
      : null;
    const upstreamNote =
      upstreamHours !== null && upstreamHours - ageHours >= 6
        ? ` (upstream DB itself was built ${upstreamHours}h ago)`
        : "";
    if (ageMs > DB_STALE_AFTER_MS) {
      return {
        ok: false,
        detail: `Last vulnerability DB refresh was ${ageHours}h ago${upstreamNote}. It refreshes automatically overnight and on every deploy — if this persists, check network connectivity from the control container.`,
      };
    }
    return {
      ok: true,
      detail: `Vulnerability DB refreshed ${ageHours}h ago${upstreamNote}`,
    };
  } catch (err: any) {
    if (err?.code === "ENOENT") {
      return {
        ok: false,
        detail: "Vulnerability DB not downloaded yet. The first deploy will fetch it (~500 MB) from mirror.gcr.io",
      };
    }
    return {
      ok: false,
      detail: `Could not read DB metadata: ${err?.message ?? err}`,
    };
  }
}
