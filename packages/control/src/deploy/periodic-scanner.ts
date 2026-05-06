import { listApps, type App } from "../db/apps.js";
import {
  getLatestPeriodicScan,
  getLatestPeriodicScanFindings,
  insertPeriodicScan,
} from "../db/periodic-scans.js";
import { getSetting } from "../db/settings.js";
import { assertSafeOutboundUrl } from "../util/ssrf-guard.js";
import {
  buildScanResult,
  effectiveThreshold,
  scanImage,
  trivyAvailable,
  type Finding,
  type Threshold,
} from "./scan.js";
import { isValidThreshold } from "./scan.js";

/**
 * Background image rescanner.
 *
 * Trivy refreshes its CVE DB every ~6h, so an image that was clean at
 * deploy time can grow new findings later. Once a day we rerun the
 * `image vuln` scan against every running app's current image tag and
 * record the result on `app_periodic_scans` so the dashboard can show
 * a delta. Findings that are new compared to the previous periodic
 * scan AND at HIGH or CRITICAL trigger a webhook notification, if one
 * is configured.
 *
 * The scanner is best-effort: a failure on one app never aborts the
 * sweep, and a Trivy outage just records `error` rows. The schedule
 * is interval-based (no cron), so a long-running install picks up the
 * cadence on next restart without any state to migrate.
 */

const HOUR_MS = 60 * 60 * 1000;
const DEFAULT_INTERVAL_HOURS = 24;
const STARTUP_DELAY_MS = 60 * 1000;
// Re-run is wasted work if the same image was scanned very recently;
// keeps `setInterval` drift + a manual "Rescan now" button from
// double-paying the Trivy cost back-to-back.
const MIN_GAP_MS = 6 * HOUR_MS;

type Logger = Pick<Console, "log" | "warn" | "error">;

interface NewFindingsDelta {
  newCriticals: Finding[];
  newHighs: Finding[];
}

/**
 * Find HIGH/CRITICAL findings present in `current` but not in `prev`,
 * keyed by `severity:id` so the same CVE appearing on a new package
 * still counts. Returns deduplicated lists.
 */
export function diffNewSevereFindings(
  prev: Finding[],
  current: Finding[],
): NewFindingsDelta {
  const prevKeys = new Set<string>();
  for (const f of prev) {
    if (f.severity === "CRITICAL" || f.severity === "HIGH") {
      prevKeys.add(`${f.severity}:${f.id}`);
    }
  }
  const seen = new Set<string>();
  const newCriticals: Finding[] = [];
  const newHighs: Finding[] = [];
  for (const f of current) {
    if (f.severity !== "CRITICAL" && f.severity !== "HIGH") continue;
    const key = `${f.severity}:${f.id}`;
    if (prevKeys.has(key) || seen.has(key)) continue;
    seen.add(key);
    if (f.severity === "CRITICAL") newCriticals.push(f);
    else newHighs.push(f);
  }
  return { newCriticals, newHighs };
}

function readIntervalHours(): number {
  const raw = process.env.PERIODIC_SCAN_INTERVAL_HOURS;
  if (!raw) return DEFAULT_INTERVAL_HOURS;
  const parsed = Number.parseFloat(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_INTERVAL_HOURS;
  return parsed;
}

function shouldScan(app: App, recentScannedAt: string | null): boolean {
  if (!app.image_tag) return false;
  if (app.status !== "running") return false;
  if (!recentScannedAt) return true;
  const last = Date.parse(recentScannedAt);
  if (!Number.isFinite(last)) return true;
  return Date.now() - last >= MIN_GAP_MS;
}

async function notifyNewFindings(
  app: App,
  delta: NewFindingsDelta,
): Promise<void> {
  if (delta.newCriticals.length === 0 && delta.newHighs.length === 0) return;
  const url = getSetting("webhook_url");
  if (!url) return;
  const check = await assertSafeOutboundUrl(url);
  if (!check.ok) return;
  try {
    await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        text: `Rescan of ${app.name ?? app.id}: ${delta.newCriticals.length} new CRITICAL, ${delta.newHighs.length} new HIGH`,
        app_id: app.id,
        app_name: app.name,
        new_criticals: delta.newCriticals.map((f) => f.id),
        new_highs: delta.newHighs.map((f) => f.id),
        timestamp: new Date().toISOString(),
      }),
      signal: AbortSignal.timeout(5000),
    });
  } catch {
    /* webhook failure must never break the sweep */
  }
}

export async function rescanApp(
  app: App,
  log: Logger = console,
): Promise<void> {
  if (!app.image_tag) return;
  let findings: Finding[] = [];
  let error: string | null = null;
  try {
    findings = await scanImage(app.image_tag);
  } catch (err) {
    error = (err as Error).message ?? "scan failed";
    log.warn(`[rescan] ${app.id}: ${error}`);
  }

  const appThreshold: Threshold = isValidThreshold(app.scan_threshold)
    ? app.scan_threshold
    : "none";
  const floorRaw = getSetting("min_scan_threshold") ?? "none";
  const floor: Threshold = isValidThreshold(floorRaw) ? floorRaw : "none";
  const threshold = effectiveThreshold(
    appThreshold,
    floor,
    app.scan_floor_exempt === 1,
  );
  const result = buildScanResult(findings, threshold);

  const previousFindings = getLatestPeriodicScanFindings(app.id);

  insertPeriodicScan({
    app_id: app.id,
    image_tag: app.image_tag,
    scan_status: error ? "skipped" : result.status,
    counts: result.counts,
    findings,
    error,
  });

  if (!error) {
    const delta = diffNewSevereFindings(previousFindings, findings);
    await notifyNewFindings(app, delta);
  }
}

export async function rescanAllApps(log: Logger = console): Promise<void> {
  if (!trivyAvailable()) {
    log.warn("[rescan] trivy not available; skipping sweep");
    return;
  }
  const apps = listApps();
  let scanned = 0;
  for (const app of apps) {
    const previous = getLatestPeriodicScan(app.id);
    if (!shouldScan(app, previous?.created_at ?? null)) continue;
    try {
      await rescanApp(app, log);
      scanned++;
    } catch (err) {
      log.error(
        `[rescan] ${app.id}: unexpected failure ${(err as Error).message}`,
      );
    }
  }
  log.log(`[rescan] sweep done: ${scanned}/${apps.length} apps scanned`);
}

export function startPeriodicScanner(log: Logger = console): () => void {
  const intervalHours = readIntervalHours();
  const intervalMs = intervalHours * HOUR_MS;
  log.log(
    `[rescan] scheduler started, every ${intervalHours}h (first run in ${Math.round(STARTUP_DELAY_MS / 1000)}s)`,
  );
  const initial = setTimeout(() => {
    rescanAllApps(log).catch((err) => {
      log.error(`[rescan] initial sweep crashed: ${(err as Error).message}`);
    });
  }, STARTUP_DELAY_MS);
  initial.unref?.();
  const handle = setInterval(() => {
    rescanAllApps(log).catch((err) => {
      log.error(`[rescan] sweep crashed: ${(err as Error).message}`);
    });
  }, intervalMs);
  handle.unref?.();
  return () => {
    clearTimeout(initial);
    clearInterval(handle);
  };
}
