/**
 * Reads the host's disk, CPU, memory and Docker data usage and stores them
 * (`store.ts`). Everything it needs comes through `CollectorDeps`, so the
 * rules are tested without a host, a Docker daemon or a clock.
 *
 * No new right: `/proc` and `statfs` are read from inside the control
 * container, `docker system df` and `buildctl du` go over the Docker socket and
 * the `docker exec` route control already uses. No extra mount, no host PID.
 *
 * Cadence: CPU and memory every minute (the store keeps a 5-minute mean), the
 * disk every 5 minutes, Docker data every 15 minutes (`docker system df` walks
 * every image and volume and can take seconds). `HOST_METRICS_INTERVAL_MS=0`
 * turns it all off.
 *
 * It never throws into control: a failed reading is stored as the reason
 * ("No data yet" on the page), logged once per change, and the previous value
 * stays. A reading that looks like the container's own view is flagged
 * (`view:*` in the state table), logged and audited once per change, and shown
 * grey instead of as the host's.
 */
import { readFile, statfs } from "node:fs/promises";
import { dirname, join } from "node:path";
import { db } from "../db/index.js";
import { buildCacheDu, dockerDiskUsage } from "../deploy/docker.js";
import {
  cpuPercent,
  diskUsage,
  judgeDisk,
  judgeMemory,
  parseBuildctlDu,
  parseCgroupLimit,
  parseDf,
  parseMeminfo,
  parseProcStat,
  type CpuTimes,
  type StatfsLike,
  type ViewVerdict,
} from "./readings.js";
import { clearState, getState, recordSample, setState } from "./store.js";

type Logger = Pick<Console, "log" | "warn" | "error">;

export interface CollectorDeps {
  readText: (path: string) => Promise<string>;
  statfs: (path: string) => Promise<StatfsLike>;
  dataDir: string;
  df: (timeoutMs: number) => Promise<unknown>;
  buildDu: (timeoutMs: number) => Promise<string>;
  now: () => number;
  /** One line in the audit log, written by the system. */
  audit: (action: string, detail: string) => void;
  log: Logger;
}

export const DISK_EVERY_MS = 5 * 60_000;
export const DATA_EVERY_MS = 15 * 60_000;
export const DOCKER_TIMEOUT_MS = 20_000;

export function realDeps(log: Logger = console): CollectorDeps {
  return {
    readText: (p) => readFile(p, "utf8"),
    statfs: (p) => statfs(p),
    dataDir: dirname(process.env.DB_PATH || join(process.cwd(), "runway.db")),
    df: dockerDiskUsage,
    buildDu: buildCacheDu,
    now: Date.now,
    audit: (action, detail) => {
      db.prepare(`INSERT INTO audit_log (user_id, username, action, detail) VALUES ('system', 'system', ?, ?)`).run(
        action,
        detail.slice(0, 500)
      );
    },
    log,
  };
}

// In-memory only: the previous CPU counters and when the disk was last read.
// A restart starts with no CPU baseline (the first minute has no CPU value).
let prevCpu: CpuTimes | null = null;
let lastDiskAt = 0;

export function resetCollector(): void {
  prevCpu = null;
  lastDiskAt = 0;
}

/** What went wrong with a reading, kept for the page ("No data yet", with the reason). */
function noteError(deps: CollectorDeps, name: string, err: unknown, now: number): void {
  const msg = (err instanceof Error ? err.message : String(err)).slice(0, 200);
  if (getState(`err:${name}`) !== msg) deps.log.warn(`[host-metrics] ${name}: ${msg}`);
  setState(`err:${name}`, msg, now);
}

function clearError(name: string): void {
  clearState(`err:${name}`);
}

/** Remember whether a reading is the host's or the container's; say so once when it changes. */
function noteView(deps: CollectorDeps, name: "mem" | "disk", verdict: ViewVerdict, now: number): void {
  const prev = getState(`view:${name}`);
  // The reason is kept for the tooltip, and follows the verdict (it can change while the view stays).
  if (verdict.view === "container") setState(`reason:${name}`, verdict.reason ?? "", now);
  else clearState(`reason:${name}`);
  if (prev === verdict.view) return;
  setState(`view:${name}`, verdict.view, now);
  if (verdict.view === "container") {
    deps.log.warn(`[host-metrics] ${name} reading is the container's view, not the host's: ${verdict.reason}`);
    try {
      deps.audit("host_metrics_container_view", `${name}: ${verdict.reason}`);
    } catch {
      /* the audit line is a courtesy */
    }
  } else if (prev === "container") {
    deps.log.log(`[host-metrics] ${name} reading is the host's again`);
  }
}

async function readCgroupLimit(deps: CollectorDeps): Promise<number | null> {
  for (const p of ["/sys/fs/cgroup/memory.max", "/sys/fs/cgroup/memory/memory.limit_in_bytes"]) {
    try {
      return parseCgroupLimit(await deps.readText(p));
    } catch {
      /* not this cgroup version */
    }
  }
  return null;
}

/** CPU and memory every call; the disk when it is due. Never throws. */
export async function collectFast(deps: CollectorDeps = realDeps()): Promise<void> {
  const now = deps.now();

  try {
    const mem = parseMeminfo(await deps.readText("/proc/meminfo"));
    if (!mem) throw new Error("/proc/meminfo has no MemTotal");
    const verdict = judgeMemory({ memTotalBytes: mem.totalBytes, cgroupLimitBytes: await readCgroupLimit(deps) });
    noteView(deps, "mem", verdict, now);
    recordSample("mem_used_bytes", mem.totalBytes - mem.availableBytes, now);
    setState("mem_total_bytes", String(mem.totalBytes), now);
    clearError("mem");
  } catch (err) {
    noteError(deps, "mem", err, now);
  }

  try {
    const cur = parseProcStat(await deps.readText("/proc/stat"));
    if (!cur) throw new Error("/proc/stat has no cpu line");
    if (prevCpu) {
      const pct = cpuPercent(prevCpu, cur);
      if (pct !== null) recordSample("cpu_pct", pct, now);
    }
    prevCpu = cur;
    clearError("cpu");
  } catch (err) {
    prevCpu = null;
    noteError(deps, "cpu", err, now);
  }

  if (now - lastDiskAt >= DISK_EVERY_MS - 1000) {
    try {
      const s = await deps.statfs(deps.dataDir);
      const usage = diskUsage(s);
      if (!usage) throw new Error(`statfs(${deps.dataDir}) returned no usable sizes`);
      noteView(deps, "disk", judgeDisk(s), now);
      recordSample("disk_used_bytes", usage.usedBytes, now);
      setState("disk_last", JSON.stringify({ total: usage.totalBytes, used: usage.usedBytes, free: usage.freeBytes, pct: usage.pct }), now);
      lastDiskAt = now;
      clearError("disk");
    } catch (err) {
      noteError(deps, "disk", err, now);
    }
  }
}

/**
 * `docker system df` and `buildctl du`. A timeout or failure keeps the previous
 * numbers (the page says when they were measured) and stores the reason.
 */
export async function collectData(deps: CollectorDeps = realDeps()): Promise<void> {
  const now = deps.now();
  let usage;
  try {
    usage = parseDf(await deps.df(DOCKER_TIMEOUT_MS));
    if (!usage) throw new Error("docker system df gave an answer in a shape this version does not know");
  } catch (err) {
    noteError(deps, "data", err, now);
    return;
  }

  // The BuildKit cache volume is counted once: from `buildctl du`, else from
  // its volume's size (an estimate), else not at all, and then the page says so.
  let buildkit: number | null = null;
  let note: string | null = null;
  try {
    buildkit = parseBuildctlDu(await deps.buildDu(DOCKER_TIMEOUT_MS));
    if (buildkit === null) note = "BuildKit cache: buildctl du gave output this version does not know";
  } catch (err) {
    note = `BuildKit cache: ${(err instanceof Error ? err.message : String(err)).slice(0, 120)}`;
  }
  if (buildkit === null && usage.buildkitVolumeBytes !== null) {
    buildkit = usage.buildkitVolumeBytes;
    note = `${note ?? "BuildKit cache"}; estimated from its volume`;
  }
  if (buildkit === null) note = `${note ?? "BuildKit cache"}; build cache not included`;
  else if (note && !note.includes("estimated")) note = null;

  recordSample("data_images_bytes", usage.imagesBytes, now);
  recordSample("data_containers_bytes", usage.containersBytes, now);
  recordSample("data_volumes_bytes", usage.volumesBytes, now);
  recordSample("data_buildcache_bytes", usage.dockerBuildCacheBytes + (buildkit ?? 0), now);
  setState("data_note", note ?? "", now);
  clearError("data");
}

// ── Scheduling ───────────────────────────────────────────────────

let fastRunning = false;
let dataRunning = false;

export function startHostMetrics(log: Logger = console): () => void {
  const raw = process.env.HOST_METRICS_INTERVAL_MS;
  // Empty or a typo = the default (a typo must not switch the measuring off);
  // only a number of 0 or less does.
  const parsed = raw === undefined || raw === "" ? 60_000 : Number(raw);
  const interval = Number.isNaN(parsed) ? 60_000 : parsed;
  if (interval <= 0) {
    log.log("[host-metrics] disabled (HOST_METRICS_INTERVAL_MS=0)");
    return () => {};
  }
  const every = Math.max(interval, 5_000);
  log.log(`[host-metrics] started (cpu and memory every ${Math.round(every / 1000)}s, disk every 5 min, docker data every 15 min)`);

  const fast = setInterval(() => {
    if (fastRunning) return;
    fastRunning = true;
    collectFast(realDeps(log))
      .catch((err) => log.error(`[host-metrics] tick crashed: ${(err as Error).message}`))
      .finally(() => {
        fastRunning = false;
      });
  }, every);
  fast.unref?.();

  const runData = () => {
    if (dataRunning) return;
    dataRunning = true;
    collectData(realDeps(log))
      .catch((err) => log.error(`[host-metrics] data tick crashed: ${(err as Error).message}`))
      .finally(() => {
        dataRunning = false;
      });
  };
  // The first Docker reading waits half a minute so start-up is not slowed down.
  const first = setTimeout(runData, 30_000);
  first.unref?.();
  const data = setInterval(runData, DATA_EVERY_MS);
  data.unref?.();

  return () => {
    clearInterval(fast);
    clearTimeout(first);
    clearInterval(data);
  };
}
