/**
 * Stop / start / restart / trash / restore / purge of one app.
 *
 * Rules that must stay:
 * - One lifecycle action per app at a time (`withLock`): a double click or a
 *   click during another action answers "busy" instead of racing Docker.
 * - Nothing is changed while a deploy, scan or start is running on the app
 *   (`building` / `scanning` / `starting`): the answer is "busy", never a wait.
 * - Stop writes the maintenance route FIRST and then stops the container, so
 *   visitors never see a 502 in between. Start writes the app route only after
 *   the container is healthy. The container, image, volumes, env and domain are
 *   never touched by Stop (same as quarantine).
 * - A quarantined app is never started here (its own rules bring it back).
 * - The trash keeps the row (so the domain stays reserved: domain checks look
 *   at every row) and the data; only `purgeApp` removes things for good.
 * - Events are written here, audit rows by the caller who knows the person.
 *
 * Docker and the gateway are reached through the same helpers as deploys.
 */
import {
  deleteApp,
  getApp,
  listDeletedApps,
  updateApp,
  type App,
} from "../db/apps.js";
import { getEnvVars } from "../db/env.js";
import { emitEvent } from "../db/events.js";
import { logAudit } from "../db/audit.js";
import { getQuarantine, shiftKevClocks } from "../db/quarantine.js";
import {
  containerImageTag,
  removeContainerByName,
  restartContainerByName,
  runContainer,
  startContainerByName,
  stopContainerByName,
} from "./docker.js";
import { appBasicAuth, writeAppRoute, writeMaintenanceRoute } from "./gateway.js";
import { waitForHealthy } from "./health.js";
import { appContainerName, buildVolumeBinds, destroyApp } from "./index.js";

/** How long a trashed app can be restored. */
export const TRASH_DAYS = 7;
const TRASH_MS = TRASH_DAYS * 86_400_000;
const IN_FLIGHT = new Set(["building", "scanning", "starting"]);

export type LifecycleFailure =
  | "not_found"
  | "in_trash"
  | "busy"
  | "quarantined"
  | "no_image"
  | "unhealthy"
  | "confirm"
  | "not_in_trash";

export type LifecycleResult =
  | { ok: true; changed: boolean; app: App; note?: string }
  | { ok: false; code: LifecycleFailure; message: string };

/** HTTP status for a failure, shared by the dashboard, the API and the tests. */
export function failureStatus(code: LifecycleFailure): 400 | 404 | 409 | 502 {
  switch (code) {
    case "not_found":
      return 404;
    case "busy":
    case "quarantined":
    case "in_trash":
    case "not_in_trash":
    case "no_image":
      return 409;
    case "unhealthy":
      return 502;
    case "confirm":
      return 400;
  }
}

const fail = (code: LifecycleFailure, message: string): LifecycleResult => ({ ok: false, code, message });
const done = (app: App, changed: boolean, note?: string): LifecycleResult => ({ ok: true, changed, app, ...(note ? { note } : {}) });

const locks = new Set<string>();

async function withLock(appId: string, fn: () => Promise<LifecycleResult>): Promise<LifecycleResult> {
  if (locks.has(appId)) return fail("busy", "Another action on this app is still running. Try again in a moment.");
  locks.add(appId);
  try {
    return await fn();
  } finally {
    locks.delete(appId);
  }
}

/** The text that must be typed to confirm a removal: the app's name (its id while it has none). */
export function confirmationName(app: Pick<App, "id" | "name">): string {
  return app.name ?? app.id;
}

function load(appId: string, opts: { allowTrash?: boolean } = {}): { app: App } | { err: LifecycleResult } {
  const app = getApp(appId);
  if (!app) return { err: fail("not_found", "App not found.") };
  if (app.deleted_at && !opts.allowTrash) return { err: fail("in_trash", "This app is in the trash. Restore it first.") };
  return { app };
}

const busyReason = (app: App): LifecycleResult | null =>
  IN_FLIGHT.has(app.status)
    ? fail("busy", `A deploy or start is in progress (${app.status}). Wait for it to finish, then try again.`)
    : null;

async function maintenanceRoute(app: App): Promise<void> {
  if (app.domain) {
    await writeMaintenanceRoute({ appId: app.id, domain: app.domain, customDomain: app.custom_domain });
  }
}

async function appRoute(app: App): Promise<void> {
  if (!app.domain) return;
  await writeAppRoute({
    appId: app.id,
    containerName: appContainerName(app.id),
    domain: app.domain,
    customDomain: app.custom_domain,
    port: app.port,
    basicAuth: appBasicAuth(app),
    ssoEnabled: !!app.sso_enabled,
  });
}

/** Create the container from the app's current image (volumes untouched) and start it. */
async function createFromImage(app: App): Promise<void> {
  await removeContainerByName(appContainerName(app.id));
  await runContainer({
    appId: app.id,
    containerName: appContainerName(app.id),
    imageTag: app.image_tag!,
    port: app.port,
    env: getEnvVars(app.id),
    volumes: buildVolumeBinds(app.id),
    cpuLimit: app.cpu_limit,
    memoryLimit: app.memory_limit,
    hardening: app.hardening_profile,
    readonlyRootfs: app.readonly_rootfs === 1,
    healthCheckPath: app.health_check_path,
  });
}

// ── Stop ─────────────────────────────────────────────────────────

async function stopInner(app: App): Promise<LifecycleResult> {
  const busy = busyReason(app);
  if (busy) return busy;
  if (app.status === "stopped") return done(app, false, "The app was already stopped.");
  if (app.status === "quarantined") {
    // Already offline behind the maintenance page; its own rules decide when it comes back.
    await stopContainerByName(appContainerName(app.id)).catch(() => {});
    return done(app, false, "The app is already offline because of a quarantine.");
  }
  await maintenanceRoute(app);
  try {
    await stopContainerByName(appContainerName(app.id));
  } catch (err) {
    // The container is still up: put the real route back, do not leave a maintenance page over a running app.
    await appRoute(app).catch(() => {});
    throw err;
  }
  const updated = updateApp(app.id, { status: "stopped", stopped_at: new Date().toISOString() })!;
  emitEvent({ appId: app.id, code: "app_stopped" });
  return done(updated, true);
}

export function stopApp(appId: string): Promise<LifecycleResult> {
  const l = load(appId);
  if ("err" in l) return Promise.resolve(l.err);
  return withLock(appId, () => stopInner(getApp(appId)!));
}

// ── Start / restart ──────────────────────────────────────────────

async function bringUp(app: App, mode: "start" | "restart"): Promise<LifecycleResult> {
  const name = appContainerName(app.id);
  const previous = app.status;
  updateApp(app.id, { status: "starting" });
  try {
    if (mode === "restart" && previous !== "stopped" && (await containerImageTag(name)) === app.image_tag) {
      await restartContainerByName(name);
    } else if ((await containerImageTag(name)) === app.image_tag) {
      await startContainerByName(name);
    } else {
      await createFromImage(app);
    }
    const health = await waitForHealthy(name, { hasHealthcheck: !!app.health_check_path });
    if (!health.healthy) {
      await stopContainerByName(name).catch(() => {});
      await maintenanceRoute(app).catch(() => {});
      updateApp(app.id, { status: "failed" });
      emitEvent({ appId: app.id, code: "app_start_failed" });
      return fail("unhealthy", `The app did not become healthy: ${health.reason}. It was stopped again; check the logs.`);
    }
    await appRoute(app);
  } catch (err) {
    updateApp(app.id, { status: previous === "stopped" ? "stopped" : "failed" });
    throw err;
  }
  // The fix period of a KEV did not run while a person had the app off.
  if (app.stopped_at) {
    const off = Date.now() - Date.parse(app.stopped_at);
    if (Number.isFinite(off)) shiftKevClocks(app.id, off);
  }
  const updated = updateApp(app.id, { status: "running", stopped_at: null })!;
  emitEvent({ appId: app.id, code: mode === "restart" && previous !== "stopped" ? "app_restarted" : "app_started" });
  return done(updated, true);
}

function startChecks(app: App): LifecycleResult | null {
  const busy = busyReason(app);
  if (busy) return busy;
  if (app.status === "quarantined") {
    return fail(
      "quarantined",
      "This app is in quarantine (an actively exploited vulnerability was not fixed in time). It comes back by itself once a rebuild or deploy fixes it, or when an admin grants an exemption."
    );
  }
  if (!app.image_tag) return fail("no_image", "Deploy the app once first: there is no version to start.");
  return null;
}

export function startApp(appId: string): Promise<LifecycleResult> {
  const l = load(appId);
  if ("err" in l) return Promise.resolve(l.err);
  return withLock(appId, async () => {
    const app = getApp(appId)!;
    const refused = startChecks(app);
    if (refused) return refused;
    if (app.status === "running") return done(app, false, "The app was already running.");
    return bringUp(app, "start");
  });
}

export function restartApp(appId: string): Promise<LifecycleResult> {
  const l = load(appId);
  if ("err" in l) return Promise.resolve(l.err);
  return withLock(appId, async () => {
    const app = getApp(appId)!;
    const refused = startChecks(app);
    if (refused) return refused;
    return bringUp(app, "restart");
  });
}

// ── Trash ────────────────────────────────────────────────────────

/** Move to the trash: stop it, keep everything, reserve the domain for TRASH_DAYS. */
export function trashApp(appId: string, confirm: unknown): Promise<LifecycleResult> {
  const l = load(appId);
  if ("err" in l) return Promise.resolve(l.err);
  if (typeof confirm !== "string" || confirm.trim() !== confirmationName(l.app)) {
    return Promise.resolve(fail("confirm", `Type the app's name exactly (${confirmationName(l.app)}) to confirm.`));
  }
  return withLock(appId, async () => {
    const app = getApp(appId)!;
    const busy = busyReason(app);
    if (busy) return busy;
    // Same as Stop, but a quarantined app keeps its status (its container is already off).
    if (app.status !== "stopped" && app.status !== "quarantined") {
      await maintenanceRoute(app);
      await stopContainerByName(appContainerName(app.id));
    } else {
      await stopContainerByName(appContainerName(app.id)).catch(() => {});
      if (app.status === "stopped") await maintenanceRoute(app).catch(() => {});
    }
    const updated = updateApp(app.id, {
      deleted_at: new Date().toISOString(),
      status: app.status === "quarantined" ? "quarantined" : "stopped",
      stopped_at: app.stopped_at ?? new Date().toISOString(),
    })!;
    emitEvent({ appId: app.id, code: "app_deleted" });
    return done(updated, true);
  });
}

/** Bring a trashed app back: as a stopped app, with its data. Start is a separate step. */
export function restoreFromTrash(appId: string): Promise<LifecycleResult> {
  const l = load(appId, { allowTrash: true });
  if ("err" in l) return Promise.resolve(l.err);
  if (!l.app.deleted_at) return Promise.resolve(fail("not_in_trash", "This app is not in the trash."));
  return withLock(appId, async () => {
    const app = getApp(appId)!;
    if (!app.deleted_at) return fail("not_in_trash", "This app is not in the trash.");
    const quarantined = getQuarantine(app.id)?.state === "quarantined";
    const updated = updateApp(app.id, {
      deleted_at: null,
      status: quarantined ? "quarantined" : "stopped",
    })!;
    emitEvent({ appId: app.id, code: "app_restored" });
    return done(updated, true);
  });
}

/**
 * Remove a trashed app for good: container, network, route, stored sources,
 * then the row (which takes its events, deploys, env and volumes list with it).
 * Idempotent: a second call finds nothing and says so.
 */
export function purgeApp(appId: string, opts: { confirm?: unknown; skipConfirm?: boolean } = {}): Promise<LifecycleResult> {
  const l = load(appId, { allowTrash: true });
  if ("err" in l) return Promise.resolve(l.err);
  if (!l.app.deleted_at) return Promise.resolve(fail("not_in_trash", "Only an app in the trash can be removed for good."));
  if (!opts.skipConfirm && (typeof opts.confirm !== "string" || opts.confirm.trim() !== confirmationName(l.app))) {
    return Promise.resolve(fail("confirm", `Type the app's name exactly (${confirmationName(l.app)}) to confirm.`));
  }
  return withLock(appId, async () => {
    const app = getApp(appId);
    if (!app) return fail("not_found", "App not found.");
    await destroyApp(app);
    deleteApp(app.id);
    return done(app, true);
  });
}

/** Purge every trashed app older than TRASH_DAYS. Never throws; one failure does not stop the rest. */
export async function purgeExpiredTrash(
  now: number = Date.now(),
  log: Pick<Console, "log" | "error"> = console
): Promise<string[]> {
  const purged: string[] = [];
  try {
    for (const app of listDeletedApps()) {
      const at = Date.parse(app.deleted_at ?? "");
      if (!Number.isFinite(at) || now - at < TRASH_MS) continue;
      try {
        const r = await purgeApp(app.id, { skipConfirm: true });
        if (r.ok) {
          purged.push(app.id);
          logAudit("system", "system", "app_purged", { detail: `${app.id}: trash term (${TRASH_DAYS} days) ended`.slice(0, 500) });
          log.log(`[trash] purged ${app.id}`);
        }
      } catch (err) {
        log.error(`[trash] ${app.id}: purge failed: ${(err as Error).message}`);
      }
    }
  } catch (err) {
    log.error(`[trash] sweep failed: ${(err as Error).message}`);
  }
  return purged;
}

let timer: ReturnType<typeof setInterval> | null = null;

/** Sweep once now (covers a long downtime) and then every hour. */
export function startTrashPurger(log: Pick<Console, "log" | "error"> = console): () => void {
  void purgeExpiredTrash(Date.now(), log);
  timer = setInterval(() => void purgeExpiredTrash(Date.now(), log), 3_600_000);
  timer.unref?.();
  return () => {
    if (timer) clearInterval(timer);
    timer = null;
  };
}
