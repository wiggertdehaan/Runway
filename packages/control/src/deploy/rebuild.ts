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
import { countSeverity, scanImage, trivyAvailable, type Finding, type ScanResult } from "./scan.js";
import { latestSource } from "./source.js";
import { readDockerfileFromTar } from "./dockerfile.js";
import { planBasePatches, type BasePlan, type UsedBaseImage } from "./base-images.js";
import { createTagSource } from "./registry.js";
import { notifyRebuildSummary } from "../util/webhook.js";

type Logger = Pick<Console, "log" | "warn" | "error">;

let sharedTagSource: ReturnType<typeof createTagSource> | null = null;
/** One shared registry client so its 10-minute tag cache spans a whole run. */
function tagSource() {
  return (sharedTagSource ??= createTagSource());
}

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


export interface GateVerdict {
  allow: boolean;
  reason: string;
}

/**
 * Pure: may a rebuilt image replace the running one? Yes iff its scan is
 * not worse than the running version: no CRITICAL CVE that the running
 * image doesn't have, and no actively exploited (KEV) CVE it doesn't
 * have. Fewer or equal findings always pass, even when the app's own
 * scan threshold would have blocked a fresh deploy of the same image
 * (the running version carries those findings too). Without a trustworthy
 * scan on either side we cannot compare, so we refuse.
 */
export function evaluateRebuildGate(
  current: Finding[] | null,
  next: ScanResult,
  kev: Set<string>
): GateVerdict {
  if (next.status === "skipped") {
    return { allow: false, reason: "scan of the new build unavailable, cannot verify it is not worse" };
  }
  if (current === null) {
    return { allow: false, reason: "no scan of the running version to compare against" };
  }
  const cur = current.filter((f) => f.source === "image");
  const nxt = next.findings.filter((f) => f.source === "image");
  const curCrit = new Set(cur.filter((f) => f.severity === "CRITICAL").map((f) => f.id));
  const curIds = new Set(cur.map((f) => f.id.toUpperCase()));

  const newCrit = [...new Set(nxt.filter((f) => f.severity === "CRITICAL" && !curCrit.has(f.id)).map((f) => f.id))];
  const newKev = [...new Set(
    kevFindings(nxt, kev).map((f) => f.id.toUpperCase()).filter((id) => !curIds.has(id))
  )];

  const list = (ids: string[]) => ids.slice(0, 3).join(", ") + (ids.length > 3 ? `, +${ids.length - 3} more` : "");
  const problems: string[] = [];
  if (newCrit.length) problems.push(`${newCrit.length} new critical (${list(newCrit)})`);
  if (newKev.length) problems.push(`${newKev.length} new actively exploited (${list(newKev)})`);
  if (problems.length) {
    return { allow: false, reason: `new build is worse than the running version: ${problems.join("; ")}` };
  }
  return { allow: true, reason: "not worse than the running version" };
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
    const patched = r.patched?.length
      ? ` [base ${r.patched.map((p) => `${p.from}→${p.to}`).join(", ")}]`
      : "";
    return `- ${name}: ${r.outcome.replace("_", " ")}${delta}${patched}${why}`;
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

  const previousStatus = app.status;

  // Baseline for "before" and for the gate: a fresh scan of the image that
  // is running right now (the vuln DB moves daily). If Trivy fails on it,
  // fall back to the last periodic scan of that same image.
  let currentFindings: Finding[] | null = null;
  try {
    currentFindings = (await scanImage(app.image_tag)).filter((f) => f.source === "image");
  } catch {
    const periodic = getLatestPeriodicScan(app.id);
    if (periodic && periodic.image_tag === app.image_tag) {
      currentFindings = getLatestPeriodicScanFindings(app.id);
    }
  }
  const before = currentFindings ? snapshot(currentFindings, kev) : null;
  let plan: BasePlan | undefined;
  let usedBases: UsedBaseImage[] = [];

  try {
    const tar = await readFile(source.path);

    // Raise exact patch pins (nginx:1.30.6-alpine -> 1.30.7-alpine) in a
    // build-time copy of the Dockerfile. Best effort: any problem here
    // means "build as the owner wrote it", never a failed rebuild.
    if (app.auto_patch_base) {
      try {
        const dockerfile = readDockerfileFromTar(tar);
        if (dockerfile) {
          const planned = await planBasePatches(dockerfile, tagSource());
          if (planned.patches.length > 0) plan = planned;
        }
      } catch (err: any) {
        log.warn(`[rebuild] ${app.id}: base patch planning failed: ${err?.message ?? err}`);
      }
    }

    const result = await deployApp({
      app,
      tar,
      noCache: true,
      verifyHealth: true,
      skipSourceSave: true,
      basePlan: plan,
      scanGate: (scan) => evaluateRebuildGate(currentFindings, scan, kev),
    });
    usedBases = result.base_images;
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
      base_images: usedBases,
      patched: plan?.patches,
      detail: result.scan.status === "skipped" ? "scan skipped" : undefined,
    });
  } catch (err: any) {
    const baseExtra = {
      base_images: (err?.baseImages as UsedBaseImage[] | undefined) ?? usedBases,
      patched: plan?.patches,
    };
    if (err instanceof ScanBlockedError) {
      // The old container never stopped, but deployApp left the status
      // on "scanning"; put it back.
      updateApp(app.id, { status: previousStatus });
      return done("blocked", {
        before,
        after: snapshot(err.scan.findings, kev),
        detail: err.message,
        ...baseExtra,
      });
    }
    if (err instanceof UnhealthyDeployError) {
      return done(err.restored ? "rolled_back" : "failed", {
        before,
        detail: err.message,
        ...baseExtra,
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
    return done("failed", { before, detail: err?.message ?? "rebuild failed", ...baseExtra });
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
