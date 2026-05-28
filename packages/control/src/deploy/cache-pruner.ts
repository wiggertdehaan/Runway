import { pruneBuildCache } from "./docker.js";

/**
 * Periodically evict BuildKit cache blobs older than one week. Without
 * this, layers from every deploy accumulate in BuildKit's content store
 * and silently fill the host disk — measured at ~10 GB across a handful
 * of apps after a few weeks of normal use. Image-level retention covers
 * the loaded daemon side; this covers the builder side.
 *
 * Interval-based, mirroring periodic-scanner.ts: a long-running install
 * picks up the cadence on next restart, no state to migrate.
 */

const HOUR_MS = 60 * 60 * 1000;
const INTERVAL_MS = 7 * 24 * HOUR_MS;
const STARTUP_DELAY_MS = 5 * 60 * 1000;
const KEEP_DURATION = "168h";

type Logger = Pick<Console, "log" | "warn" | "error">;

export async function runCachePrune(log: Logger = console): Promise<void> {
  try {
    const summary = await pruneBuildCache(KEEP_DURATION);
    log.log(`[cache-prune] ${summary}`);
  } catch (err) {
    log.warn(`[cache-prune] failed: ${(err as Error).message}`);
  }
}

export function startCachePruner(log: Logger = console): () => void {
  log.log(
    `[cache-prune] scheduler started, every 7d (first run in ${Math.round(STARTUP_DELAY_MS / 1000)}s)`
  );
  const initial = setTimeout(() => {
    runCachePrune(log);
  }, STARTUP_DELAY_MS);
  initial.unref?.();
  const handle = setInterval(() => {
    runCachePrune(log);
  }, INTERVAL_MS);
  handle.unref?.();
  return () => {
    clearTimeout(initial);
    clearInterval(handle);
  };
}
