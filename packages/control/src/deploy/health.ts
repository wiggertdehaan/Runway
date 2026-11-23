import { getContainerStatus, type ContainerStatus } from "./docker.js";

export type HealthVerdict = "healthy" | "unhealthy" | "pending";

/**
 * Pure: turn one container status snapshot into a verdict.
 *
 * - Container gone / exited / dead / restarting -> unhealthy (a crash
 *   loop under `restart: unless-stopped` shows up as "restarting").
 * - App has a healthcheck: wait for Docker to report "healthy";
 *   "unhealthy" is final, "starting" is still pending.
 * - No healthcheck: "running" is only trusted after `stableMs`, so a
 *   process that crashes a second after start is not called healthy.
 */
export function judgeHealth(
  status: ContainerStatus,
  hasHealthcheck: boolean,
  runningForMs: number,
  stableMs: number
): HealthVerdict {
  if (!status.exists) return "unhealthy";
  const state = status.state ?? "";
  if (state === "exited" || state === "dead" || state === "restarting") {
    return "unhealthy";
  }
  if (state !== "running") return "pending";
  if (hasHealthcheck) {
    if (status.health === "healthy") return "healthy";
    if (status.health === "unhealthy") return "unhealthy";
    return "pending";
  }
  return runningForMs >= stableMs ? "healthy" : "pending";
}

export interface WaitOptions {
  hasHealthcheck: boolean;
  timeoutMs?: number;
  pollMs?: number;
  stableMs?: number;
  getStatus?: (name: string) => Promise<ContainerStatus>;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

export interface WaitResult {
  healthy: boolean;
  reason: string;
}

/**
 * Poll a freshly started container until it is healthy, provably
 * unhealthy, or the timeout expires (counted as unhealthy).
 */
export async function waitForHealthy(
  containerName: string,
  opts: WaitOptions
): Promise<WaitResult> {
  const timeoutMs = opts.timeoutMs ?? 120_000;
  const pollMs = opts.pollMs ?? 2_000;
  const stableMs = opts.stableMs ?? 10_000;
  const getStatus = opts.getStatus ?? getContainerStatus;
  const sleep =
    opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const now = opts.now ?? Date.now;

  const start = now();
  let last: ContainerStatus = { exists: false };
  while (now() - start <= timeoutMs) {
    last = await getStatus(containerName);
    const verdict = judgeHealth(
      last,
      opts.hasHealthcheck,
      now() - start,
      stableMs
    );
    if (verdict === "healthy") return { healthy: true, reason: "healthy" };
    if (verdict === "unhealthy") {
      return {
        healthy: false,
        reason: `container ${last.exists ? (last.health === "unhealthy" ? "healthcheck failing" : (last.state ?? "unknown")) : "disappeared"}`,
      };
    }
    await sleep(pollMs);
  }
  return {
    healthy: false,
    reason: `not healthy after ${Math.round(timeoutMs / 1000)}s (state=${last.state ?? "?"}, health=${last.health ?? "none"})`,
  };
}
