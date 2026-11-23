/**
 * The system health checks, shared by the /health page and the overview's
 * "Health" figure. One list of checks, so the two can never disagree about
 * what "healthy" means.
 *
 * The overview is opened far more often than anybody needs a fresh Docker
 * ping, so `cachedHealth` keeps the last result for a short while. The
 * /health page itself always runs the checks.
 */
import { getSetting } from "../db/settings.js";
import { docker } from "../deploy/docker.js";
import { getScannerHealth } from "../deploy/scan.js";
import { checkWildcardDns } from "../util/dns-check.js";
import type { HealthSummary } from "./build.js";

export interface HealthCheck {
  name: string;
  ok: boolean;
  detail: string;
}

/** Run every check. Never throws: a check that blows up is a failed check. */
export async function runHealthChecks(): Promise<HealthCheck[]> {
  const checks: HealthCheck[] = [];
  const baseDomain = getSetting("base_domain");

  try {
    await docker.ping();
    checks.push({ name: "Docker", ok: true, detail: "Socket reachable" });
  } catch {
    checks.push({ name: "Docker", ok: false, detail: "Cannot reach Docker socket" });
  }

  try {
    const info = await docker.getContainer("runway-buildkit").inspect();
    const running = info.State.Status === "running";
    checks.push({ name: "BuildKit", ok: running, detail: running ? "Running" : `Status: ${info.State.Status}` });
  } catch {
    checks.push({ name: "BuildKit", ok: false, detail: "Container not found" });
  }

  if (baseDomain) {
    try {
      const dns = await checkWildcardDns(baseDomain);
      checks.push({ name: "Wildcard DNS", ok: dns.ok, detail: dns.message });
    } catch {
      checks.push({ name: "Wildcard DNS", ok: false, detail: "The DNS check failed" });
    }
  } else {
    checks.push({ name: "Wildcard DNS", ok: false, detail: "No base domain configured" });
  }

  try {
    const info = await docker.getContainer("runway-gateway").inspect();
    const running = info.State.Status === "running";
    checks.push({ name: "Traefik", ok: running, detail: running ? "Running" : `Status: ${info.State.Status}` });
  } catch {
    checks.push({ name: "Traefik", ok: false, detail: "Container not found" });
  }

  // Security scanner (Trivy): binary, cache volume and vulnerability DB fail independently.
  try {
    const scanner = await getScannerHealth();
    checks.push({ name: "Scanner binary", ok: scanner.binary.ok, detail: scanner.binary.detail });
    checks.push({ name: "Scanner cache", ok: scanner.cache.ok, detail: scanner.cache.detail });
    checks.push({ name: "Vulnerability DB", ok: scanner.db.ok, detail: scanner.db.detail });
  } catch {
    checks.push({ name: "Scanner", ok: false, detail: "The scanner check failed" });
  }

  return checks;
}

/** What the overview needs from a list of checks. */
export function summarizeHealth(checks: HealthCheck[]): HealthSummary {
  return { total: checks.length, failed: checks.filter((c) => !c.ok).map((c) => c.name) };
}

const TTL_MS = 30_000;
let cache: { at: number; summary: HealthSummary } | null = null;
let inflight: Promise<HealthSummary> | null = null;

/**
 * The summary, at most 30 seconds old. Concurrent callers share one run.
 * Test hook: pass a `now` and a `run` to control both.
 */
export async function cachedHealth(
  now: number = Date.now(),
  run: () => Promise<HealthCheck[]> = runHealthChecks
): Promise<HealthSummary> {
  if (cache && now - cache.at < TTL_MS) return cache.summary;
  if (inflight) return inflight;
  inflight = run()
    .then((checks) => {
      const summary = summarizeHealth(checks);
      cache = { at: now, summary };
      return summary;
    })
    .finally(() => {
      inflight = null;
    });
  return inflight;
}

/** Forget the cached result (tests). */
export function resetHealthCache(): void {
  cache = null;
  inflight = null;
}
