import { readFile } from "node:fs/promises";
import { listApps, getApp, updateApp, type App } from "../db/apps.js";
import {
  getLatestPeriodicScan,
  getLatestPeriodicScanFindings,
  insertPeriodicScan,
} from "../db/periodic-scans.js";
import {
  createRebuildRun,
  finishRebuildRun,
  saveRebuildResults,
  type RebuildAppResult,
  type RebuildOutcome,
  type SeverityCounts,
} from "../db/rebuild-runs.js";
import {
  deployApp,
  ScanBlockedError,
  UnhealthyDeployError,
  PreflightRejectedError,
} from "./index.js";
import { getContainerStatus } from "./docker.js";
import { appContainerName } from "./index.js";
import { getKevList, kevFindings } from "./kev.js";
import { countSeverity, trivyAvailable, type Finding } from "./scan.js";
import { latestSource } from "./source.js";
import { notifyRebuildSummary } from "../util/webhook.js";

type Logger = Pick<Console, "log" | "warn" | "error">;

/** Statuses during which a deploy/build is already in flight. */
const BUSY_STATUSES = new Set(["building", "scanning", "starting"]);

/**
 * Pure: should the weekly job rebuild this app? Yes when its latest
 * scan shows an actively exploited CVE (CISA KEV), or a CRITICAL that
 * already has a fixed version available (a rebuild can actually pick
 * the fix up). Returns the reason, or null.
 */
export function rebuildReason(
  findings: Finding[],
  kev: Set<string>
): string | null {
  const image = findings.filter((f) => f.source === "image");
  const kevHits = kevFindings(image, kev);
  const criticalFixable = image.filter(
    (f) => f.severity === "CRITICAL" && !!f.fixedVersion
  );
  const parts: string[] = [];
  if (kevHits.length > 0) parts.push(`${kevHits.length} actively exploited (KEV)`);
  if (criticalFixable.length > 0) {
    const ids = new Set(criticalFixable.map((f) => f.id));
    parts.push(`${ids.size} critical with fix`);
  }
  return parts.length > 0 ? parts.join(", ") : null;
}

export function snapshot(
  findings: Finding[],
  kev: Set<string>
): { counts: SeverityCounts; kev: number } {
  const image = findings.filter((f) => f.source === "image");
  return {
    counts: countSeverity(image),
    kev: kevFindings(image, kev).length,
  };
}

/** Pure: one-line-per-app text for the admin notification. */
export function summarizeRun(
  trigger: "manual" | "scheduled",
  results: RebuildAppResult[]
): string {
  if (results.length === 0) {
    return `Runway rebuild (${trigger}): no apps needed a rebuild.`;
  }
  const tally: Record<string, number> = {};
  for (const r of results) tally[r.outcome] = (tally[r.outcome] ?? 0) + 1;
  const head = Object.entries(tally)
    .map(([k, v]) => `${v} ${k.replace("_", " ")}`)
    .join(", ");
  const lines = results.map((r) => {
    const name = r.app_name ?? r.app_id;
    const delta =
      r.before && r.after
        ? ` (critical ${r.before.counts.critical}→${r.after.counts.critical}, KEV ${r.before.kev}→${r.after.kev})`
        : "";
    const why = r.detail && r.outcome !== "rebuilt" ? `: ${r.detail}` : "";
    return `- ${name}: ${r.outcome.replace("_", " ")}${delta}${why}`;
  });
  return `Runway rebuild (${trigger}): ${head}\n${lines.join("\n")}`;
}

/**
 * Rebuild one app from its stored source with no BuildKit cache, run it
 * through the normal scan gate, and verify the new container is healthy
 * (restoring the previous deploy if not). Never throws: every failure
 * becomes an outcome so a batch can continue with the next app.
 */
export async function rebuildApp(
  appIn: App,
  kev: Set<string>,
  log: Logger = console
): Promise<RebuildAppResult> {
  const started = Date.now();
  const base = {
    app_id: appIn.id,
    app_name: appIn.name,
  };
  const done = (
    outcome: RebuildOutcome,
    extra: Partial<RebuildAppResult> = {}
  ): RebuildAppResult => ({
    ...base,
    outcome,
    before: null,
    after: null,
    duration_s: Math.round((Date.now() - started) / 1000),
    ...extra,
  });

  // Re-read: the app may have changed since the batch was planned.
  const app = getApp(appIn.id);
  if (!app) return done("skipped", { detail: "app no longer exists" });
  if (!app.image_tag) return done("skipped", { detail: "never deployed" });
  if (BUSY_STATUSES.has(app.status)) {
    return done("skipped", { detail: `a deploy is in progress (${app.status})` });
  }
  const source = latestSource(app.id);
  if (!source) {
    return done("skipped", { detail: "no stored source to rebuild from" });
  }

  const beforeFindings = getLatestPeriodicScanFindings(app.id);
  const hadBaseline = !!getLatestPeriodicScan(app.id);
  const before = hadBaseline ? snapshot(beforeFindings, kev) : null;
  const previousStatus = app.status;

  try {
    const tar = await readFile(source.path);
    const result = await deployApp({
      app,
      tar,
      noCache: true,
      verifyHealth: true,
      skipSourceSave: true,
    });
    const imageFindings = result.scan.findings.filter((f) => f.source === "image");
    // The deploy-time scan doubles as the new baseline for the daily
    // rescan, so it diffs against this build and not the old image.
    if (result.scan.status !== "skipped") {
      insertPeriodicScan({
        app_id: app.id,
        image_tag: result.image_tag,
        scan_status: result.scan.status,
        counts: countSeverity(imageFindings),
        findings: imageFindings,
        error: null,
      });
    }
    const after =
      result.scan.status === "skipped" ? null : snapshot(imageFindings, kev);
    return done("rebuilt", {
      before,
      after,
      detail: result.scan.status === "skipped" ? "scan skipped" : undefined,
    });
  } catch (err: any) {
    if (err instanceof ScanBlockedError) {
      // The old container never stopped, but deployApp left the status
      // on "scanning"; put it back.
      updateApp(app.id, { status: previousStatus });
      return done("blocked", {
        before,
        after: snapshot(err.scan.findings, kev),
        detail: err.message,
      });
    }
    if (err instanceof UnhealthyDeployError) {
      return done(err.restored ? "rolled_back" : "failed", {
        before,
        detail: err.message,
      });
    }
    if (err instanceof PreflightRejectedError) {
      updateApp(app.id, { status: previousStatus });
      return done("failed", { before, detail: err.message });
    }
    // Build or infrastructure failure. The old container may still be
    // serving; only mark the app failed if it is not.
    let serving = false;
    try {
      serving = (await getContainerStatus(appContainerName(app.id))).state === "running";
    } catch {
      /* treat as not serving */
    }
    updateApp(app.id, { status: serving ? previousStatus : "failed" });
    log.warn(`[rebuild] ${app.id}: ${err?.message ?? err}`);
    return done("failed", { before, detail: err?.message ?? "rebuild failed" });
  }
}

export class RebuildBusyError extends Error {
  constructor() {
    super("A rebuild run is already in progress");
  }
}

let activeRunId: number | null = null;

export function activeRebuildRunId(): number | null {
  return activeRunId;
}

export interface RunOptions {
  trigger: "manual" | "scheduled";
  /** Specific apps (manual). Omit for "all apps" (manual) or auto-selection. */
  appIds?: string[];
  /** Scheduled mode: only apps with KEV / critical-with-fix and auto_rebuild on. */
  onlyVulnerable?: boolean;
  log?: Logger;
}

/**
 * Start a rebuild run in the background and return its id. Apps are
 * rebuilt strictly one after another (a build is memory-heavy and the
 * box also serves traffic). Only one run at a time.
 */
export function startRebuildRun(opts: RunOptions): number {
  if (activeRunId !== null) throw new RebuildBusyError();
  const runId = createRebuildRun(opts.trigger);
  activeRunId = runId;
  void executeRun(runId, opts).finally(() => {
    activeRunId = null;
  });
  return runId;
}

async function executeRun(runId: number, opts: RunOptions): Promise<void> {
  const log = opts.log ?? console;
  const results: RebuildAppResult[] = [];
  try {
    if (!trivyAvailable()) {
      log.warn("[rebuild] trivy not available; scan gate cannot run, aborting");
      results.push({
        app_id: "-",
        app_name: null,
        outcome: "failed",
        before: null,
        after: null,
        detail: "trivy not available; refusing to rebuild without the scan gate",
      });
      return;
    }
    const kevList = await getKevList();
    if (kevList.stale) {
      log.warn(
        `[rebuild] KEV list ${kevList.fetchedAt ? "is stale" : "unavailable"}; KEV counts may be incomplete`
      );
    }

    let apps = listApps().filter((a) => a.image_tag);
    if (opts.appIds) apps = apps.filter((a) => opts.appIds!.includes(a.id));
    const reasons = new Map<string, string>();
    if (opts.onlyVulnerable) {
      apps = apps.filter((a) => {
        if (!a.auto_rebuild) return false;
        const reason = rebuildReason(
          getLatestPeriodicScanFindings(a.id),
          kevList.ids
        );
        if (reason) reasons.set(a.id, reason);
        return reason !== null;
      });
    }

    for (const app of apps) {
      const r = await rebuildApp(app, kevList.ids, log);
      const why = reasons.get(app.id);
      if (why && r.outcome === "rebuilt") r.detail = r.detail ?? `selected: ${why}`;
      results.push(r);
      saveRebuildResults(runId, results);
      log.log(`[rebuild] ${app.id}: ${r.outcome}${r.detail ? ` (${r.detail})` : ""}`);
    }
  } catch (err: any) {
    log.error(`[rebuild] run ${runId} crashed: ${err?.message ?? err}`);
    results.push({
      app_id: "-",
      app_name: null,
      outcome: "failed",
      before: null,
      after: null,
      detail: `run crashed: ${err?.message ?? err}`,
    });
  } finally {
    saveRebuildResults(runId, results);
    finishRebuildRun(runId);
    // Scheduled runs with nothing to do stay quiet; manual runs and
    // anything that did work report back.
    if (opts.trigger === "manual" || results.length > 0) {
      await notifyRebuildSummary(summarizeRun(opts.trigger, results), runId);
    }
  }
}
