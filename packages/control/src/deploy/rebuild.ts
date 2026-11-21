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
import { escalateBase, type EscalationStep } from "./escalation.js";
import { evaluateRebuildGate, requireKevFree } from "./gate.js";
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


export { evaluateRebuildGate, type GateVerdict } from "./gate.js";

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
    const esc = (r.escalation ?? [])
      .map((e) =>
        e.kind === "major" && e.outcome === "notice"
          ? ` [${e.detail.split(".")[0]}]`
          : e.outcome === "applied"
            ? ` [auto-minor ${e.from}→${e.to}]`
            : ` [minor ${e.to} ${e.outcome}: ${e.detail}]`
      )
      .join("");
    return `- ${name}: ${r.outcome.replace("_", " ")}${delta}${patched}${esc}${why}`;
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
  const quarantined = app.status === "quarantined";

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

  let tarForEscalation: Buffer | undefined;
  try {
    const tar = await readFile(source.path);
    tarForEscalation = tar;

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

    let result = await deployApp({
      app,
      tar,
      noCache: true,
      verifyHealth: true,
      skipSourceSave: true,
      basePlan: plan,
      // A quarantined app may only come back with a KEV-free build.
      keepOffline: quarantined,
      scanGate: (scan) => {
        const v = evaluateRebuildGate(currentFindings, scan, kev);
        return quarantined ? requireKevFree(v, scan, kev) : v;
      },
    });
    usedBases = result.base_images;

    // Patch stage is live. If an actively exploited / fixable-critical
    // finding survived it, escalate to a newer minor line (lowest first).
    let escalation: EscalationStep[] | undefined;
    if (app.auto_minor_base && result.scan.status !== "skipped") {
      try {
        const dockerfile = readDockerfileFromTar(tar);
        if (dockerfile) {
          const esc = await escalateBase({
            app,
            tar,
            dockerfile,
            plan,
            liveFindings: result.scan.findings.filter((f) => f.source === "image"),
            kev,
            tagSource: tagSource(),
            quarantined,
            log,
          });
          escalation = esc.steps.length > 0 ? esc.steps : undefined;
          if (esc.result) {
            result = esc.result;
            usedBases = esc.baseImages ?? result.base_images;
            plan = esc.plan ?? plan;
          }
        }
      } catch (err: any) {
        // Stage 1 is already live; escalation problems never fail the rebuild.
        log.warn(`[rebuild] ${app.id}: escalation failed: ${err?.message ?? err}`);
      }
    }

    const imageFindings = result.scan.findings.filter((f) => f.source === "image");
    const after =
      result.scan.status === "skipped" ? null : snapshot(imageFindings, kev);
    return done("rebuilt", {
      before,
      after,
      base_images: usedBases,
      patched: plan?.patches,
      escalation,
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

      // A quarantined app's plain rebuild is blocked while the KEV is still
      // there. That is exactly when a newer minor line may be the fix, so
      // escalate from the current image instead of giving up.
      let escalation: EscalationStep[] | undefined;
      if (quarantined && app.auto_minor_base && currentFindings && tarForEscalation) {
        try {
          const dockerfile = readDockerfileFromTar(tarForEscalation);
          if (dockerfile) {
            const esc = await escalateBase({
              app,
              tar: tarForEscalation,
              dockerfile,
              plan: undefined,
              liveFindings: currentFindings,
              kev,
              tagSource: tagSource(),
              quarantined: true,
              log,
            });
            escalation = esc.steps.length > 0 ? esc.steps : undefined;
            if (esc.result) {
              const fresh = esc.result.scan.findings.filter((f) => f.source === "image");
              return done("rebuilt", {
                before,
                after: snapshot(fresh, kev),
                base_images: esc.baseImages ?? esc.result.base_images,
                patched: esc.plan?.patches,
                escalation,
              });
            }
          }
        } catch (e: any) {
          log.warn(`[rebuild] ${app.id}: escalation from quarantine failed: ${e?.message ?? e}`);
        }
      }
      return done("blocked", {
        before,
        after: snapshot(err.scan.findings, kev),
        detail: err.message,
        escalation,
        ...baseExtra,
      });
    }
    if (err instanceof UnhealthyDeployError) {
      if (quarantined) updateApp(app.id, { status: "quarantined" });
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
    // A quarantined app is deliberately not serving: it stays quarantined.
    updateApp(app.id, { status: quarantined ? "quarantined" : serving ? previousStatus : "failed" });
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
        // A quarantined app is always retried, whatever its opt-out says:
        // a successful rebuild is how it gets back online.
        if (!a.auto_rebuild && a.status !== "quarantined") return false;
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
