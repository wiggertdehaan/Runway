import { docker } from "./docker.js";
import { appContainerName, appImageTag } from "./index.js";
import type { App } from "../db/apps.js";

export interface AppStats {
  /** Docker image size on disk, in bytes. null if the image is missing. */
  imageBytes: number | null;
  /** Current memory usage, in bytes. null if the container isn't running. */
  memoryBytes: number | null;
  /** ISO timestamp of when the current container started. null if no container. */
  startedAt: string | null;
  /** Container state string from Docker (running, exited, restarting, …). */
  containerState: string | null;
}

const EMPTY_STATS: AppStats = {
  imageBytes: null,
  memoryBytes: null,
  startedAt: null,
  containerState: null,
};

/**
 * Collect live stats for a single app. Swallows errors from Docker so
 * one broken container does not break the dashboard render.
 */
export async function getAppStats(app: App): Promise<AppStats> {
  const name = appContainerName(app.id);
  const tag = appImageTag(app.id);

  const [imageBytes, runtimeState] = await Promise.all([
    fetchImageSize(tag),
    fetchContainerState(name),
  ]);

  return {
    imageBytes,
    memoryBytes: runtimeState.memoryBytes,
    startedAt: runtimeState.startedAt,
    containerState: runtimeState.state,
  };
}

/**
 * Fetch stats for many apps in parallel and return them in the same
 * order as the input. Always resolves; errors become EMPTY_STATS.
 */
export async function getAppStatsBulk(apps: App[]): Promise<AppStats[]> {
  return Promise.all(
    apps.map((app) => getAppStats(app).catch(() => EMPTY_STATS))
  );
}

async function fetchImageSize(tag: string): Promise<number | null> {
  try {
    const info = await docker.getImage(tag).inspect();
    return typeof info.Size === "number" ? info.Size : null;
  } catch (err: any) {
    if (err.statusCode === 404) return null;
    return null;
  }
}

async function fetchContainerState(name: string) {
  try {
    const container = docker.getContainer(name);
    const info = await container.inspect();
    const state = info.State?.Status ?? null;
    const startedAt = info.State?.StartedAt ?? null;

    // Only pull stats when actually running — otherwise Docker
    // returns an error or a zeroed snapshot and it's wasted time.
    let memoryBytes: number | null = null;
    if (state === "running") {
      try {
        const stats = (await container.stats({
          stream: false,
        })) as DockerStats;
        memoryBytes = extractMemoryBytes(stats);
      } catch {
        memoryBytes = null;
      }
    }

    return { state, startedAt, memoryBytes };
  } catch (err: any) {
    if (err.statusCode === 404) {
      return { state: null, startedAt: null, memoryBytes: null };
    }
    return { state: null, startedAt: null, memoryBytes: null };
  }
}

interface DockerStats {
  memory_stats?: {
    usage?: number;
    stats?: { cache?: number; inactive_file?: number };
  };
}

/**
 * Docker reports memory including the page cache, which inflates the
 * number compared to what tools like `docker stats` show. Subtract the
 * cache portion so we match what users expect.
 */
function extractMemoryBytes(stats: DockerStats): number | null {
  const usage = stats.memory_stats?.usage;
  if (typeof usage !== "number") return null;
  const cacheLike =
    stats.memory_stats?.stats?.inactive_file ??
    stats.memory_stats?.stats?.cache ??
    0;
  return Math.max(0, usage - cacheLike);
}
