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
import { latestSource, saveSource } from "./source.js";
import { getLatestDeploys } from "../db/deploys.js";
import { readDockerfileFromTar } from "./dockerfile.js";
import { planBasePatches, type BasePlan, type UsedBaseImage } from "./base-images.js";
import { escalateBase, type EscalationStep } from "./escalation.js";
import { ecosystemOf, planDepUpdates, withholdMajors, type DepPlan } from "./dep-updates.js";
import { runDepStage, type DepStep } from "./dep-stage.js";
import { recentDepFailures } from "../db/dep-attempts.js";
import { evaluateRebuildGate, requireKevFree } from "./gate.js";
import { createTagSource } from "./registry.js";
import { notifyRebuildSummary } from "../util/webhook.js";

type Logger = Pick<Console, "log" | "warn" | "error">;

let sharedTagSource: ReturnType<typeof createTagSource> | null = null;
/** One shared registry client so its 10-minute tag cache spans a whole run. */
function tagSource() {
  return (sharedTagSource ??= createTagSource());
}

/** Major dependency jumps tried per rebuild; each one is a full build. */
export const MAX_MAJOR_DEP_UPDATES = 3;
/** Single-package retries after a failed batch of compatible updates. */
export const MAX_SINGLE_DEP_RETRIES = 3;

/** Statuses during which a deploy/build is already in flight. */
const BUSY_STATUSES = new Set(["building", "scanning", "starting"]);

/**
 * Pure: should the weekly job rebuild this app? Yes when its latest
 * scan shows an actively exploited CVE (CISA KEV), or a CRITICAL that
 * already has a fixed version available (a rebuild can actually pick
 * the fix up). With `deps` (the app lets Runway raise its dependencies)
 * a HIGH with a fix in one of the app's own packages counts too: a
 * rebuild can now fix that as well. Returns the reason, or null.
 */
export function rebuildReason(
  findings: Finding[],
  kev: Set<string>,
  opts: { deps?: boolean; major?: boolean; skip?: Set<string> } = {}
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
  if (opts.deps) {
    // Only what a rebuild would actually try: an update that failed or
    // could not be placed recently (`skip`) is not a reason to rebuild.
    const plan = planDepUpdates(image, kev, { skip: opts.skip });
    const planned = new Set([...plan.compatible, ...(opts.major ? plan.major : [])].flatMap((u) => u.cves));
    const highDeps = new Set(
      image
        .filter((f) => f.severity === "HIGH" && ecosystemOf(f) !== null && planned.has(f.id.toUpperCase()))
        .map((f) => f.id)
    );
    if (highDeps.size > 0) parts.push(`${highDeps.size} high with fix in app dependencies`);
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
    const applied = (r.deps ?? []).filter((d) => d.outcome === "applied");
    // "ineffective" is listed with what was not applied: the finding is still there.
    const notApplied = (r.deps ?? []).filter((d) => d.outcome !== "applied" && d.outcome !== "skipped");
    const deps =
      (applied.length ? ` [deps ${applied.map((d) => `${d.pkg} ${d.from}→${d.to}`).join(", ")}]` : "") +
      (notApplied.length
        ? ` [deps not applied: ${notApplied.map((d) => `${d.pkg} ${d.to} ${d.outcome}`).join(", ")}]`
        : "");
    return `- ${name}: ${r.outcome.replace("_", " ")}${delta}${patched}${esc}${deps}${why}`;
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
  log: Logger = console,
  opts: { retryFailedDeps?: boolean } = {}
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
  const depSteps: DepStep[] = [];
  const deps = () => (depSteps.length > 0 ? depSteps : undefined);
  try {
    const tar = await readFile(source.path);
    tarForEscalation = tar;
    // The source that is live. Starts as the stored tar and becomes the
    // patched copy once a dependency stage has gone live, so that later
    // stages build on it instead of quietly undoing it.
    let liveTar: Buffer = tar;
    const dockerfileText = readDockerfileFromTar(tar);

    // Which of the app's own packages to raise (see dep-updates.ts).
    let depPlan: DepPlan | undefined;
    if (app.auto_update_deps && currentFindings) {
      try {
        const planned = planDepUpdates(currentFindings, kev, {
          skip: opts.retryFailedDeps ? undefined : recentDepFailures(app.id),
        });
        const split = withholdMajors(planned, !!app.auto_update_deps_major);
        depPlan = split.plan;
        depSteps.push(...split.withheld);
        for (const s of depPlan.skipped) {
          depSteps.push({
            ecosystem: s.ecosystem, pkg: s.name, from: "", to: "", kind: "compatible",
            outcome: "skipped", detail: s.reason,
          });
        }
      } catch (err: any) {
        log.warn(`[rebuild] ${app.id}: dependency planning failed: ${err?.message ?? err}`);
      }
    }

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

    // Stage 1 with the compatible dependency updates folded in. If that
    // build does not go live for any reason, fall through to the plain
    // rebuild below: the app must never be worse off for the attempt.
    // An app last deployed before per-deploy snapshots has one legacy
    // source file with no deploy id. Once a patched snapshot exists that
    // file can no longer be downloaded, so give it a deploy id first: the
    // owner must always be able to get back what they uploaded.
    let originalDeployId = source.deployId;
    if (originalDeployId === null && depPlan && depPlan.compatible.length + depPlan.major.length > 0) {
      try {
        const running = getLatestDeploys(app.id, 50).find(
          (d) => d.status === "success" && d.image_tag === app.image_tag
        );
        if (running) {
          saveSource(app.id, running.id, tar);
          originalDeployId = running.id;
        }
      } catch (err: any) {
        log.warn(`[rebuild] ${app.id}: could not keep the uploaded source: ${err?.message ?? err}`);
      }
      // Without a retrievable original we do not change the source at all.
      if (originalDeployId === null) {
        for (const u of [...depPlan.compatible, ...depPlan.major]) {
          depSteps.push({
            ecosystem: u.ecosystem, pkg: u.name, from: u.from, to: u.to, kind: u.kind,
            outcome: "skipped", detail: "the uploaded source could not be kept as a snapshot first",
          });
        }
        depPlan = undefined;
      }
    }

    let withDeps: Awaited<ReturnType<typeof deployApp>> | undefined;
    let depsHalted = false;
    if (depPlan && depPlan.compatible.length > 0) {
      const stage = await runDepStage({
        app, tar, dockerfile: dockerfileText, updates: depPlan.compatible, strict: false,
        baseline: currentFindings, kev, plan, quarantined, previousStatus,
        originalDeployId, log,
      });
      depsHalted = stage.halted;
      if (stage.result && stage.tar) {
        depSteps.push(...stage.steps);
        withDeps = stage.result;
        liveTar = stage.tar;
        tarForEscalation = liveTar;
      } else {
        // The batch did not go live. With several packages in it, one bad
        // one would otherwise hold the others back for good: try them one
        // at a time, each on top of what went live before it.
        const retry = stage.steps.filter((s) => s.outcome === "blocked" || s.outcome === "failed");
        const single = retry.length > 1 && !stage.halted;
        depSteps.push(...stage.steps.filter((s) => !single || !retry.includes(s)));
        if (single) {
          let baseline = currentFindings;
          let stillQuarantined = quarantined;
          let tried = 0;
          for (const update of depPlan.compatible) {
            if (!retry.some((s) => s.pkg === update.name && s.to === update.to)) continue;
            if (tried >= MAX_SINGLE_DEP_RETRIES) {
              depSteps.push({
                ecosystem: update.ecosystem, pkg: update.name, from: update.from, to: update.to,
                kind: update.kind, outcome: "skipped", detail: "left for the next rebuild",
              });
              continue;
            }
            tried++;
            const one = await runDepStage({
              app, tar: liveTar, dockerfile: dockerfileText, updates: [update], strict: true,
              baseline, kev, plan, quarantined: stillQuarantined,
              previousStatus: stillQuarantined ? previousStatus : withDeps ? "running" : previousStatus,
              originalDeployId, log,
            });
            depSteps.push(...one.steps);
            if (one.result && one.tar) {
              withDeps = one.result;
              liveTar = one.tar;
              tarForEscalation = liveTar;
              baseline = one.result.scan.findings.filter((f) => f.source === "image");
              stillQuarantined = false;
            }
            if (one.halted) {
              depsHalted = true;
              break;
            }
          }
        }
      }
    }

    let result =
      withDeps ??
      (await deployApp({
        app: getApp(app.id) ?? app,
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
      }));
    usedBases = result.base_images;

    // Patch stage is live. If an actively exploited / fixable-critical
    // finding survived it, escalate to a newer minor line (lowest first).
    let escalation: EscalationStep[] | undefined;
    if (app.auto_minor_base && result.scan.status !== "skipped") {
      try {
        const dockerfile = dockerfileText;
        if (dockerfile) {
          const esc = await escalateBase({
            app,
            tar: liveTar,
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

    // Major dependency jumps: one package per build, each on top of what
    // is live, so one that does not build or start costs nothing but time.
    if (depPlan && depPlan.major.length > 0 && !depsHalted && result.scan.status !== "skipped") {
      let tried = 0;
      for (const update of depPlan.major) {
        const live = result.scan.findings.filter((f) => f.source === "image");
        const present = new Set(live.map((f) => f.id.toUpperCase()));
        if (!update.cves.some((id) => present.has(id))) continue; // already gone
        if (tried >= MAX_MAJOR_DEP_UPDATES) {
          depSteps.push({
            ecosystem: update.ecosystem, pkg: update.name, from: update.from, to: update.to,
            kind: "major", outcome: "skipped", detail: "left for the next rebuild",
          });
          continue;
        }
        tried++;
        const stage = await runDepStage({
          app, tar: liveTar, dockerfile: dockerfileText, updates: [update], strict: true,
          baseline: live, kev, plan, quarantined: false, previousStatus: "running",
          originalDeployId, log,
        });
        depSteps.push(...stage.steps);
        if (stage.result && stage.tar) {
          result = stage.result;
          usedBases = result.base_images;
          liveTar = stage.tar;
        }
        if (stage.halted) break;
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
      deps: deps(),
      detail: result.scan.status === "skipped" ? "scan skipped" : undefined,
    });
  } catch (err: any) {
    const baseExtra = {
      base_images: (err?.baseImages as UsedBaseImage[] | undefined) ?? usedBases,
      patched: plan?.patches,
      deps: deps(),
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
                deps: deps(),
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
      return done("failed", { before, detail: err.message, deps: deps() });
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
          kevList.ids,
          a.auto_update_deps
            ? { deps: true, major: !!a.auto_update_deps_major, skip: recentDepFailures(a.id) }
            : {}
        );
        if (reason) reasons.set(a.id, reason);
        return reason !== null;
      });
    }

    for (const app of apps) {
      // A rebuild someone asked for retries dependency updates that failed
      // before; the weekly job leaves those alone for a while.
      const r = await rebuildApp(app, kevList.ids, log, {
        retryFailedDeps: opts.trigger === "manual",
      });
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
