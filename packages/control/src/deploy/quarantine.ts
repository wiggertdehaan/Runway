import { getApp, listApps, updateApp, type App } from "../db/apps.js";
import { logAudit } from "../db/audit.js";
import { getLatestPeriodicScan, getLatestPeriodicScanFindings } from "../db/periodic-scans.js";
import {
  addNotice,
  deleteQuarantine,
  getActiveExemption,
  getExemption,
  getQuarantine,
  saveQuarantine,
  type QuarantineRow,
} from "../db/quarantine.js";
import { getQuarantineTermDays } from "../db/settings.js";
import { emitEvent } from "../db/events.js";
import { exemptionPhase, kevCountdownThreshold, kevEventCode } from "../util/events.js";
import { notifyAdminWebhook } from "../util/webhook.js";
import { stopContainerByName } from "./docker.js";
import { writeMaintenanceRoute } from "./gateway.js";
import { appContainerName, restoreApp } from "./index.js";
import { getKevList, kevFindings } from "./kev.js";
import { RebuildBusyError, activeRebuildRunId, startRebuildRun } from "./rebuild.js";

/**
 * KEV quarantine.
 *
 * Policy: an actively exploited (CISA KEV) CVE in the RUNTIME packages of
 * a running app starts a grace term (admin setting, default 7 days) with
 * a notice on day 0. The scan is of the final image, so build-stage
 * packages never count. If the CVE is still there when the term ends and
 * one last rebuild attempt (with minor escalation) did not fix it, the
 * app is quarantined: traffic goes to a maintenance page through the
 * gateway and the container is stopped; volumes and data stay. As soon as
 * a rebuild (or deploy) resolves the CVE the app comes back online by
 * itself. An admin can grant a time-boxed exemption (reason + end date,
 * audit-logged). Ordinary CRITICALs never quarantine anything.
 */

type Logger = Pick<Console, "log" | "warn" | "error">;

const TICK_MS = 60 * 1000;
const SYSTEM_USER = "system";

// ── Pure decision ────────────────────────────────────────────────

export interface DecisionInput {
  now: number;
  termMs: number;
  row: QuarantineRow | undefined;
  /** KEV CVE ids currently present in the app's runtime packages. */
  kevIds: string[];
  /** An admin exemption is active right now. */
  exempt: boolean;
  /** Some rebuild run is in progress (the final attempt may be among it). */
  rebuildActive: boolean;
  /**
   * The app is serving traffic right now. A row that says "quarantined" for
   * an app that is online means someone deployed over the quarantine (an
   * owner deploy that still contains the KEV): it must go straight back.
   */
  online?: boolean;
}

export type QuarantineAction =
  | { type: "start_grace"; ids: string[] }
  | { type: "new_kev"; ids: string[] }
  | { type: "resolve" }
  | { type: "attempt_rebuild" }
  | { type: "quarantine"; ids: string[] }
  | { type: "lift_exempt" };

export interface Decision {
  /** Row to persist; null means "delete the row". */
  row: Omit<QuarantineRow, "updated_at"> | null;
  actions: QuarantineAction[];
}

export function decideQuarantine(
  appId: string,
  input: DecisionInput
): Decision {
  const { now, termMs, row, kevIds, exempt, rebuildActive } = input;

  if (kevIds.length === 0) {
    return { row: null, actions: row ? [{ type: "resolve" }] : [] };
  }

  const nowIso = new Date(now).toISOString();
  const seen: Record<string, string> = {};
  for (const id of kevIds) seen[id] = row?.kev_first_seen[id] ?? nowIso;

  const next: Omit<QuarantineRow, "updated_at"> = {
    app_id: appId,
    state: row?.state ?? "grace",
    kev_first_seen: seen,
    attempt_at: row?.attempt_at ?? null,
    quarantined_at: row?.quarantined_at ?? null,
  };
  const actions: QuarantineAction[] = [];

  if (!row) {
    actions.push({ type: "start_grace", ids: kevIds });
  } else {
    const fresh = kevIds.filter((id) => !(id in row.kev_first_seen));
    if (fresh.length > 0) actions.push({ type: "new_kev", ids: fresh });
  }

  if (exempt) {
    if (row?.state === "quarantined") {
      next.state = "grace";
      next.quarantined_at = null;
      actions.push({ type: "lift_exempt" });
    }
    return { row: next, actions };
  }

  if (next.state === "quarantined") {
    if (input.online) actions.push({ type: "quarantine", ids: kevIds });
    return { row: next, actions };
  }

  const overdue = kevIds.filter(
    (id) => Date.parse(seen[id]) + termMs <= now
  );
  if (overdue.length > 0) {
    if (!next.attempt_at) {
      actions.push({ type: "attempt_rebuild" }); // effect sets attempt_at when it starts
    } else if (!rebuildActive) {
      next.state = "quarantined";
      next.quarantined_at = nowIso;
      actions.push({ type: "quarantine", ids: overdue });
    }
  }
  return { row: next, actions };
}

/** When the earliest KEV's term ends (ISO), or null. */
export function deadlineOf(
  row: Pick<QuarantineRow, "kev_first_seen">,
  termMs: number
): string | null {
  const times = Object.values(row.kev_first_seen).map((t) => Date.parse(t));
  const first = Math.min(...times);
  return Number.isFinite(first) ? new Date(first + termMs).toISOString() : null;
}

// ── Effects ──────────────────────────────────────────────────────

function label(app: App): string {
  return app.name ?? app.id;
}

async function announce(
  app: App,
  kind: string,
  message: string,
  extra: Record<string, unknown> = {}
): Promise<void> {
  addNotice(app.id, kind, message);
  const evCode = kevEventCode(kind);
  if (evCode) {
    emitEvent({
      appId: app.id,
      code: evCode,
      facts: {
        cves: Array.isArray(extra.cves) ? (extra.cves as string[]) : undefined,
        deadline: typeof extra.deadline === "string" ? extra.deadline : undefined,
      },
    });
  }
  logAudit(SYSTEM_USER, SYSTEM_USER, `quarantine_${kind}`, {
    detail: `${app.id}: ${message}`.slice(0, 500),
  });
  await notifyAdminWebhook(`Runway ${label(app)}: ${message}`, {
    app_id: app.id,
    app_name: app.name,
    event: kind,
    ...extra,
  });
}

/** Stop the container (volumes stay) and route the app's hosts to /maintenance. */
export async function quarantineApp(app: App): Promise<void> {
  await stopContainerByName(appContainerName(app.id));
  if (app.domain) {
    await writeMaintenanceRoute({
      appId: app.id,
      domain: app.domain,
      customDomain: app.custom_domain,
    });
  }
  updateApp(app.id, { status: "quarantined" });
}

function fmtDays(ms: number): string {
  const days = ms / 86_400_000;
  if (days >= 1) return `${Math.round(days * 10) / 10} day(s)`;
  const mins = Math.max(1, Math.round(ms / 60_000));
  return `${mins} minute(s)`;
}

/**
 * Tell the owner how close the end of the fix period is: once at 7, 3 and 1 day
 * left (the tightest threshold crossed), never twice for the same deadline.
 */
export function emitCountdown(
  appId: string,
  row: Pick<QuarantineRow, "kev_first_seen">,
  termMs: number,
  now: number
): void {
  const deadline = deadlineOf(row, termMs);
  if (!deadline) return;
  const days = kevCountdownThreshold(Date.parse(deadline), now, termMs);
  if (days === null) return;
  emitEvent(
    {
      appId,
      code: `kev_deadline_${days}d` as "kev_deadline_7d" | "kev_deadline_3d" | "kev_deadline_1d",
      facts: { deadline, cves: Object.keys(row.kev_first_seen) },
      dedupeKey: `kev_deadline_${days}d:${deadline}`,
      dedupeDays: 400,
    },
    now
  );
}

/** An exemption that is about to end, or has: said once per end date. */
export function emitExemptionEvents(app: App, now: number): void {
  const e = getExemption(app.id);
  if (!e) return;
  const until = Date.parse(e.until);
  const phase = exemptionPhase(until, now);
  if (!phase) return;
  emitEvent(
    {
      appId: app.id,
      code: phase === "expired" ? "exemption_expired" : "exemption_expiring",
      facts: { until: e.until },
      dedupeKey: `exemption_${phase}:${e.until}`,
      dedupeDays: 400,
    },
    now
  );
}

/**
 * Evaluate one app against the current KEV list and apply the decision.
 * Returns the actions taken (for logs/tests).
 */
export async function evaluateAppQuarantine(
  appIn: App,
  kevIds: Set<string>,
  rebuildActive: boolean,
  log: Logger = console,
  now: number = Date.now()
): Promise<QuarantineAction[]> {
  const app = getApp(appIn.id) ?? appIn;
  if (!app.image_tag) return [];
  if (app.status !== "running" && app.status !== "quarantined") return [];

  // Judge the image that is deployed now, never a previous one.
  const scan = getLatestPeriodicScan(app.id);
  if (!scan || scan.image_tag !== app.image_tag) return [];
  const runtime = getLatestPeriodicScanFindings(app.id).filter((f) => f.source === "image");
  const present = [...new Set(kevFindings(runtime, kevIds).map((f) => f.id.toUpperCase()))];

  const termMs = getQuarantineTermDays() * 86_400_000;
  const row = getQuarantine(app.id);
  const decision = decideQuarantine(app.id, {
    now,
    termMs,
    row,
    kevIds: present,
    exempt: !!getActiveExemption(app.id, new Date(now)),
    rebuildActive,
    online: app.status === "running",
  });

  const taken: QuarantineAction[] = [];
  let finalRow = decision.row;

  for (const action of decision.actions) {
    try {
      switch (action.type) {
        case "start_grace": {
          const deadline = deadlineOf(
            { kev_first_seen: Object.fromEntries(action.ids.map((i) => [i, new Date(now).toISOString()])) },
            termMs
          );
          await announce(
            app,
            "grace_started",
            `actively exploited vulnerability found in the running app (${action.ids.join(", ")}). Fix it (rebuild or new deploy) within ${fmtDays(termMs)}, until ${deadline}, or the app is taken offline for maintenance.`,
            { cves: action.ids, deadline }
          );
          break;
        }
        case "new_kev":
          await announce(
            app,
            "kev_added",
            `additional actively exploited vulnerability: ${action.ids.join(", ")} (its own ${fmtDays(termMs)} term has started).`,
            { cves: action.ids }
          );
          break;
        case "attempt_rebuild":
          try {
            startRebuildRun({ trigger: "scheduled", appIds: [app.id], log });
            finalRow = { ...(finalRow as NonNullable<typeof finalRow>), attempt_at: new Date(now).toISOString() };
            await announce(app, "final_attempt", "term expired; running one last rebuild (with minor-line escalation when enabled for this app) before quarantine.");
          } catch (err) {
            if (!(err instanceof RebuildBusyError)) throw err;
            // another run is busy: retry on the next tick
          }
          break;
        case "quarantine":
          await quarantineApp(app);
          await announce(
            app,
            "quarantined",
            `QUARANTINED: still vulnerable to ${action.ids.join(", ")} after the term and a final rebuild. Traffic goes to a maintenance page and the container is stopped; data and volumes are kept. It comes back online automatically once a rebuild or deploy resolves this, or an admin grants an exemption.`,
            { cves: action.ids }
          );
          break;
        case "lift_exempt":
          await restoreApp(app);
          await announce(app, "exempted", "quarantine lifted by an admin exemption; app is back online.");
          break;
        case "resolve": {
          const wasOffline = app.status === "quarantined";
          if (wasOffline) await restoreApp(app);
          await announce(
            app,
            "resolved",
            wasOffline
              ? "the actively exploited vulnerability is resolved; app is back online."
              : "the actively exploited vulnerability is resolved; the quarantine term is cleared."
          );
          break;
        }
      }
      taken.push(action);
    } catch (err) {
      log.error(`[quarantine] ${app.id}: ${action.type} failed: ${(err as Error).message}`);
      // A failed state change must be retried on the next tick, so keep
      // the previous row instead of persisting the new state.
      if (
        row &&
        (action.type === "quarantine" || action.type === "lift_exempt" || action.type === "resolve")
      ) {
        finalRow = {
          app_id: row.app_id,
          state: row.state,
          kev_first_seen: row.kev_first_seen,
          attempt_at: row.attempt_at,
          quarantined_at: row.quarantined_at,
        };
      }
    }
  }

  if (finalRow === null) deleteQuarantine(app.id);
  else {
    saveQuarantine(finalRow); // also keeps the first-seen map current
    if (finalRow.state === "grace") emitCountdown(app.id, finalRow, termMs, now);
  }
  return taken;
}

let tickRunning = false;

export async function quarantineTick(log: Logger = console): Promise<void> {
  if (tickRunning) return;
  tickRunning = true;
  try {
    // Exemption end dates are plain dates in our own database: no KEV feed needed.
    for (const app of listApps()) emitExemptionEvents(app, Date.now());
    const kev = await getKevList();
    // No KEV data at all: neither quarantine nor resolve on a guess.
    if (kev.fetchedAt === null) return;
    for (const app of listApps()) {
      try {
        await evaluateAppQuarantine(app, kev.ids, activeRebuildRunId() !== null, log);
      } catch (err) {
        log.error(`[quarantine] ${app.id}: ${(err as Error).message}`);
      }
    }
  } finally {
    tickRunning = false;
  }
}

export function startQuarantineMonitor(log: Logger = console): () => void {
  log.log("[quarantine] monitor started (checks every minute; term is an admin setting)");
  const handle = setInterval(() => {
    quarantineTick(log).catch((err) =>
      log.error(`[quarantine] tick crashed: ${(err as Error).message}`)
    );
  }, TICK_MS);
  handle.unref?.();
  return () => clearInterval(handle);
}
