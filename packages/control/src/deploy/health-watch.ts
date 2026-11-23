import { listApps, type App } from "../db/apps.js";
import { emitEvent } from "../db/events.js";
import { appContainerName } from "./index.js";
import { getContainerStatus, type ContainerStatus } from "./docker.js";
import { judgeHealth } from "./health.js";
import {
  decideHealthTransition,
  type HealthState,
  type HealthTracker,
} from "../util/events.js";

/**
 * Watches the apps that are meant to be running and writes a `health_unhealthy`
 * / `health_recovered` event when one changes state. It looks once a minute,
 * only believes a change after three looks in a row, and never writes two
 * health events for an app within ten minutes, so an app that flaps is a few
 * events an hour, not a stream (the decision is `decideHealthTransition`).
 *
 * It only reads: one `docker inspect` per running app per tick. An app that is
 * building, starting, quarantined, failed or stopped is left alone (those have
 * their own events or are a person's doing), and forgotten, so its next run
 * starts from a fresh baseline.
 *
 * `HEALTH_WATCH_INTERVAL_MS=0` turns it off; the default is one minute.
 */

type Logger = Pick<Console, "log" | "warn" | "error">;

export interface WatchDeps {
  listApps: () => App[];
  getStatus: (containerName: string) => Promise<ContainerStatus>;
  emit: typeof emitEvent;
  now: () => number;
}

const trackers = new Map<string, HealthTracker>();

export function resetHealthWatch(): void {
  trackers.clear();
}

export function observedState(status: ContainerStatus, hasHealthcheck: boolean): HealthState {
  // The deploy has long since passed its start-up check, so `pending` here only
  // means "Docker has not decided": not a change worth reporting. stableMs 0 so a
  // container that is simply running without a healthcheck counts as healthy.
  const verdict = judgeHealth(status, hasHealthcheck, Number.MAX_SAFE_INTEGER, 0);
  return verdict === "unhealthy" ? "unhealthy" : "healthy";
}

export async function healthWatchTick(
  deps: WatchDeps = {
    listApps,
    getStatus: getContainerStatus,
    emit: emitEvent,
    now: Date.now,
  },
  log: Logger = console
): Promise<void> {
  const seen = new Set<string>();
  for (const app of deps.listApps()) {
    if (app.status !== "running" || !app.image_tag) continue;
    seen.add(app.id);
    try {
      const status = await deps.getStatus(appContainerName(app.id));
      const observed = observedState(status, !!app.health_check_path);
      const prev = trackers.get(app.id) ?? { state: null, streak: 0, lastEmitAt: null };
      const next = decideHealthTransition(prev, observed, deps.now());
      trackers.set(app.id, next.tracker);
      if (next.emit) deps.emit({ appId: app.id, code: next.emit }, deps.now());
    } catch (err) {
      // Docker being unreachable says nothing about the app. Do not count it.
      log.warn(`[health-watch] ${app.id}: ${(err as Error).message}`);
    }
  }
  for (const id of [...trackers.keys()]) if (!seen.has(id)) trackers.delete(id);
}

let running = false;

export function startHealthWatch(log: Logger = console): () => void {
  const raw = process.env.HEALTH_WATCH_INTERVAL_MS;
  const interval = raw === undefined || raw === "" ? 60_000 : Number(raw);
  if (!Number.isFinite(interval) || interval <= 0) {
    log.log("[health-watch] disabled (HEALTH_WATCH_INTERVAL_MS=0)");
    return () => {};
  }
  log.log(`[health-watch] started (every ${Math.round(interval / 1000)}s; a change is believed after 3 looks)`);
  const handle = setInterval(() => {
    if (running) return;
    running = true;
    healthWatchTick(undefined, log)
      .catch((err) => log.error(`[health-watch] tick crashed: ${(err as Error).message}`))
      .finally(() => {
        running = false;
      });
  }, Math.max(interval, 5_000));
  handle.unref?.();
  return () => clearInterval(handle);
}
