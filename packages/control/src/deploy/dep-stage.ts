/**
 * One attempt to rebuild an app with raised dependencies: patch a copy of
 * the source, build it, and let it go live only through the same checks
 * as any rebuild (scan gate, healthcheck with automatic restore). Never
 * throws: a failed attempt is reported and the caller carries on with
 * the source as it was.
 */
import { getApp, updateApp, type App } from "../db/apps.js";
import { recordDepAttempt, type DepAttemptOutcome } from "../db/dep-attempts.js";
import { addNotice } from "../db/quarantine.js";
import type { RebuildAppResult } from "../db/rebuild-runs.js";
import { notifyAdminWebhook } from "../util/webhook.js";
import type { BasePlan } from "./base-images.js";
import { applyDepUpdates, lockSyncViaBuildKit, type LockSync } from "./dep-apply.js";
import { depKey, describeUpdate, type DepUpdate } from "./dep-updates.js";
import { evaluateDepGate, requireKevFree } from "./gate.js";
import {
  deployApp,
  PreflightRejectedError,
  ScanBlockedError,
  UnhealthyDeployError,
  type DeployResult,
} from "./index.js";
import type { Finding } from "./scan.js";

type Logger = Pick<Console, "log" | "warn" | "error">;
export type DepStep = NonNullable<RebuildAppResult["deps"]>[number];

export interface DepStageContext {
  app: App;
  /** Source to patch: the stored tar, or the output of an earlier stage. */
  tar: Buffer;
  dockerfile: string | null;
  updates: DepUpdate[];
  /** A major jump must remove every finding it was for. */
  strict: boolean;
  /** Image findings of what runs now (baseline for the gate). */
  baseline: Finding[] | null;
  kev: Set<string>;
  plan: BasePlan | undefined;
  quarantined: boolean;
  /** Status to put back when the attempt does not go live. */
  previousStatus: string;
  /** Deploy whose snapshot holds the source as the owner uploaded it. */
  originalDeployId: number | null;
  log: Logger;
  /** Injectable for tests. */
  deploy?: typeof deployApp;
  lockSync?: LockSync;
}

export interface DepStageOutcome {
  steps: DepStep[];
  /** Set when the patched build went live. */
  result?: DeployResult;
  /** The patched source that is now live (and saved as its snapshot). */
  tar?: Buffer;
  /** The new container did not start: do not try further updates now. */
  halted: boolean;
}

function step(u: DepUpdate, outcome: DepStep["outcome"], detail?: string): DepStep {
  return { ecosystem: u.ecosystem, pkg: u.name, from: u.from, to: u.to, kind: u.kind, outcome, detail };
}

function lastLogLine(err: any): string {
  const log = typeof err?.log === "string" ? err.log : "";
  const line = log.split("\n").map((l: string) => l.trim()).filter(Boolean).pop();
  return line ? `: ${line.slice(0, 200)}` : "";
}

export async function runDepStage(ctx: DepStageContext): Promise<DepStageOutcome> {
  const { app, log } = ctx;
  const deploy = ctx.deploy ?? deployApp;
  const out: DepStageOutcome = { steps: [], halted: false };
  if (ctx.updates.length === 0) return out;

  let patched;
  try {
    patched = await applyDepUpdates(ctx.tar, ctx.updates, {
      appId: app.id,
      dockerfile: ctx.dockerfile,
      lockSync: ctx.lockSync ?? lockSyncViaBuildKit,
    });
  } catch (err: any) {
    log.warn(`[rebuild] ${app.id}: could not prepare dependency updates: ${err?.message ?? err}`);
    for (const u of ctx.updates) out.steps.push(step(u, "skipped", "could not read the stored source"));
    return out;
  }
  for (const s of patched.skipped) out.steps.push(step(s.update, "skipped", s.reason));
  if (patched.applied.length === 0) return out;

  const targets = [...new Set(patched.applied.flatMap((u) => u.cves))];
  const restoreStatus = () =>
    updateApp(app.id, { status: ctx.quarantined ? "quarantined" : ctx.previousStatus });
  const fail = (outcome: Exclude<DepAttemptOutcome, "applied">, detail: string) => {
    for (const u of patched.applied) {
      out.steps.push(step(u, outcome, detail));
      try {
        recordDepAttempt(app.id, depKey(u), outcome, detail);
      } catch {
        /* the memory is an optimisation, never a reason to fail */
      }
    }
  };

  try {
    const result = await deploy({
      app: getApp(app.id) ?? app,
      tar: patched.tar,
      noCache: true,
      verifyHealth: true,
      // The patched source becomes this deploy's snapshot, so a later
      // pull or rebuild starts from the fixed manifests.
      skipSourceSave: false,
      basePlan: ctx.plan,
      keepOffline: ctx.quarantined,
      scanGate: (scan) => {
        const v = evaluateDepGate(ctx.baseline, scan, ctx.kev, targets, ctx.strict);
        return ctx.quarantined ? requireKevFree(v, scan, ctx.kev) : v;
      },
    });
    out.result = result;
    out.tar = patched.tar;
    for (const u of patched.applied) {
      out.steps.push(step(u, "applied"));
      try {
        recordDepAttempt(app.id, depKey(u), "applied");
      } catch {
        /* see above */
      }
    }
    const list = patched.applied.map(describeUpdate).join(", ");
    const original =
      ctx.originalDeployId !== null
        ? ` Your source as you uploaded it is kept as the snapshot of deploy #${ctx.originalDeployId}.`
        : "";
    const msg = `Runway updated dependencies to fix known vulnerabilities: ${list}. Changed ${patched.files.join(", ")}; the running version and the newest source snapshot contain the update.${original} Pull the latest source before you continue working on this app.`;
    try {
      addNotice(app.id, "deps_updated", msg);
      await notifyAdminWebhook(`Runway ${app.name ?? app.id}: ${msg}`, {
        app_id: app.id,
        app_name: app.name,
        event: "deps_updated",
        updates: patched.applied.map((u) => ({ pkg: u.name, from: u.from, to: u.to, kind: u.kind })),
      });
    } catch (err: any) {
      log.warn(`[rebuild] ${app.id}: could not record the dependency notice: ${err?.message ?? err}`);
    }
    return out;
  } catch (err: any) {
    if (err instanceof ScanBlockedError) {
      // Nothing was started; deployApp left the status on "scanning".
      restoreStatus();
      fail("blocked", err.message);
      return out;
    }
    if (err instanceof UnhealthyDeployError) {
      // deployApp already put the previous version back (or kept a
      // quarantined app offline).
      if (ctx.quarantined) updateApp(app.id, { status: "quarantined" });
      fail("unhealthy", err.message);
      out.halted = true;
      return out;
    }
    restoreStatus();
    if (err instanceof PreflightRejectedError) {
      fail("failed", err.message);
      return out;
    }
    log.warn(`[rebuild] ${app.id}: build with dependency updates failed: ${err?.message ?? err}`);
    fail("failed", `${err?.message ?? "build failed"}${lastLogLine(err)}`);
    return out;
  }
}
