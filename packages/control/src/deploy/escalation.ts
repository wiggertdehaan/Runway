import { addNotice } from "../db/quarantine.js";
import { getApp, updateApp, type App } from "../db/apps.js";
import { notifyAdminWebhook } from "../util/webhook.js";
import {
  findRuntimeFrom,
  lineOf,
  parseDockerfile,
  parseImageRef,
  parseVersionTag,
  pickMajorProbe,
  pickMinorCandidates,
  planBasePatches,
  type BasePlan,
  type TagSource,
  type UsedBaseImage,
} from "./base-images.js";
import { escalationTargets, evaluateEscalationGate } from "./gate.js";
import { deployApp, ScanBlockedError, UnhealthyDeployError, type DeployResult } from "./index.js";
import type { Finding } from "./scan.js";

type Logger = Pick<Console, "log" | "warn" | "error">;

/** How many newer minor lines we are willing to try, lowest first. */
export const MAX_MINOR_TRIES = 3;

export interface EscalationStep {
  kind: "minor" | "major";
  /** Image before / candidate, e.g. "nginx:1.30.7-alpine" -> "nginx:1.31.9-alpine". */
  from: string;
  to: string;
  outcome: "applied" | "blocked" | "unhealthy" | "failed" | "notice";
  detail: string;
}

export interface EscalationOutcome {
  steps: EscalationStep[];
  /** Set when a minor jump went live: the deploy result that is now running. */
  result?: DeployResult;
  /** The plan of the live build after escalation. */
  plan?: BasePlan;
  baseImages?: UsedBaseImage[];
}

export interface EscalationContext {
  app: App;
  tar: Buffer;
  dockerfile: string;
  /** Plan of the stage-1 (patch) build that is live now, if any. */
  plan: BasePlan | undefined;
  /** Image findings of the build that is live now (baseline for the gate). */
  liveFindings: Finding[];
  kev: Set<string>;
  tagSource: TagSource;
  log: Logger;
  /**
   * The app is quarantined (container stopped, maintenance page up): every
   * candidate must come up KEV-free or the app stays offline, and a failed
   * candidate must never bring the vulnerable image back online.
   */
  quarantined?: boolean;
  /** Injectable for tests. */
  deploy?: typeof deployApp;
}

function stepList(ids: string[]): string {
  return ids.slice(0, 4).join(", ") + (ids.length > 4 ? `, +${ids.length - 4} more` : "");
}

/**
 * After the patch-level rebuild went live: if a KEV or CRITICAL-with-fix is
 * still in the image, try the LOWEST newer minor line of the same major and
 * variant that resolves it (same gate as any rebuild, plus "resolves all
 * targets", plus healthcheck with automatic restore). A newer MAJOR is
 * never applied: it is only probed (build + scan, nothing deployed) so the
 * owner can be told "major X resolves Y". Only the runtime (final) stage's
 * base is ever escalated.
 */
export async function escalateBase(ctx: EscalationContext): Promise<EscalationOutcome> {
  const { app, tar, dockerfile, kev, tagSource, log } = ctx;
  const deploy = ctx.deploy ?? deployApp;
  const steps: EscalationStep[] = [];
  const out: EscalationOutcome = { steps };

  const targets = escalationTargets(ctx.liveFindings, kev);
  if (targets.length === 0) return out;

  const parsed = parseDockerfile(dockerfile);
  const runtime = findRuntimeFrom(parsed);
  if (!runtime || runtime.resolved === null) return out;
  const ref = parseImageRef(runtime.resolved);
  if (!ref || ref.digest || !ref.tag) return out;

  // The runtime base as it is right now (after the patch stage).
  const patched = ctx.plan?.patches.find((p) => p.from === runtime.resolved);
  const nowTag = patched ? (parseImageRef(patched.to)?.tag ?? ref.tag) : ref.tag;
  const vt = parseVersionTag(nowTag);
  if (!vt) return out;
  const imageName = (tag: string) => runtime.resolved!.replace(/:[^:/]*$/, `:${tag}`);
  const nowImage = imageName(nowTag);
  const fromLine = lineOf(nowTag) ?? nowTag;

  let minorTags: string[] = [];
  try {
    minorTags = await tagSource(ref, { filter: `${vt.prefix}${vt.major}.` });
  } catch (err) {
    steps.push({
      kind: "minor", from: nowImage, to: "?", outcome: "failed",
      detail: `registry lookup failed: ${(err as Error).message}`,
    });
    return out;
  }
  const candidates = pickMinorCandidates(vt, minorTags, MAX_MINOR_TRIES);

  let live: DeployResult | undefined;
  let liveFindings = ctx.liveFindings;
  // After an unhealthy or failed build we stop altogether: no further
  // minors and no major probe (every extra build is cost and risk).
  let halted = false;

  for (const candidate of candidates) {
    const toLine = lineOf(candidate) ?? candidate;
    const to = imageName(candidate);
    let plan: BasePlan;
    try {
      plan = await planBasePatches(dockerfile, tagSource, {
        retarget: { line: runtime.line, tag: candidate, kind: "minor" },
      });
    } catch (err) {
      steps.push({ kind: "minor", from: nowImage, to, outcome: "failed", detail: (err as Error).message });
      halted = true;
      break;
    }
    if (!plan.patches.some((p) => p.kind === "minor")) {
      steps.push({ kind: "minor", from: nowImage, to, outcome: "failed", detail: "could not rewrite the runtime FROM (ARG shape or multi-line)" });
      halted = true;
      break;
    }
    const fresh = getApp(app.id) ?? app;
    try {
      const baseline = liveFindings;
      const res = await deploy({
        app: fresh,
        tar,
        noCache: true,
        verifyHealth: true,
        skipSourceSave: true,
        basePlan: plan,
        keepOffline: !!ctx.quarantined,
        scanGate: (scan) => evaluateEscalationGate(baseline, scan, kev, targets, toLine),
      });
      live = res;
      liveFindings = res.scan.findings.filter((f) => f.source === "image");
      out.result = res;
      out.plan = plan;
      out.baseImages = res.base_images;
      const msg = `auto-minor ${fromLine}→${toLine}: ${nowImage} → ${to}, because ${stepList(targets)} could not be fixed within ${fromLine}.`;
      steps.push({ kind: "minor", from: nowImage, to, outcome: "applied", detail: msg });
      addNotice(app.id, "auto_minor", msg);
      await notifyAdminWebhook(`Runway ${app.name ?? app.id}: ${msg}`, {
        app_id: app.id, app_name: app.name, event: "auto_minor", from: nowImage, to,
      });
      break;
    } catch (err: any) {
      if (err instanceof ScanBlockedError) {
        // The live (or quarantined) version is untouched; deployApp left the
        // status on "scanning".
        updateApp(app.id, { status: ctx.quarantined ? "quarantined" : "running" });
        steps.push({ kind: "minor", from: nowImage, to, outcome: "blocked", detail: err.message });
        continue; // try the next-higher minor
      }
      if (err instanceof UnhealthyDeployError) {
        steps.push({
          kind: "minor", from: nowImage, to, outcome: "unhealthy",
          detail: `${err.message}; stayed on ${nowImage}`,
        });
        halted = true; // a minor that does not start: do not try further lines
        break;
      }
      log.warn(`[rebuild] ${app.id}: minor escalation to ${candidate} failed: ${err?.message ?? err}`);
      steps.push({ kind: "minor", from: nowImage, to, outcome: "failed", detail: err?.message ?? "build failed" });
      halted = true;
      break;
    }
  }

  // No minor line fixed it: probe (never apply) the next major.
  if (!live && !halted) {
    const stillThere = targets;
    try {
      const majorFilter = vt.style === "major" ? `${vt.prefix}${vt.major + 1}` : `${vt.prefix}${vt.major + 1}.`;
      const majorTags = await tagSource(ref, { filter: majorFilter });
      const probeTag = pickMajorProbe(vt, majorTags);
      if (probeTag) {
        const plan = await planBasePatches(dockerfile, tagSource, {
          retarget: { line: runtime.line, tag: probeTag, kind: "major" },
        });
        if (plan.patches.some((p) => p.kind === "major")) {
          const fresh = getApp(app.id) ?? app;
          const res = await deploy({
            app: fresh, tar, noCache: true, skipSourceSave: true, basePlan: plan, dryRun: true,
          });
          if (res.scan.status !== "skipped") {
            const present = new Set(
              res.scan.findings.filter((f) => f.source === "image").map((f) => f.id.toUpperCase())
            );
            const solved = stillThere.filter((id) => !present.has(id));
            const majorLine = lineOf(probeTag) ?? probeTag;
            if (solved.length > 0) {
              const msg = `major ${majorLine} (${imageName(probeTag)}) resolves ${stepList(solved)}. Major jumps are never automatic: update the Dockerfile yourself after checking compatibility.`;
              steps.push({ kind: "major", from: nowImage, to: imageName(probeTag), outcome: "notice", detail: msg });
              if (addNotice(app.id, "major_available", msg, 7)) {
                await notifyAdminWebhook(`Runway ${app.name ?? app.id}: ${msg}`, {
                  app_id: app.id, app_name: app.name, event: "major_available",
                });
              }
            } else {
              steps.push({ kind: "major", from: nowImage, to: imageName(probeTag), outcome: "notice", detail: `major ${majorLine} does not resolve them either` });
            }
          }
        }
      }
    } catch (err) {
      steps.push({ kind: "major", from: nowImage, to: "?", outcome: "failed", detail: `major probe failed: ${(err as Error).message}` });
    }
  }
  return out;
}
