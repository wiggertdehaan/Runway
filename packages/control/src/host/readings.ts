/**
 * Host measurements, as pure functions: parsers for what the kernel and Docker
 * hand us, and the sanity rules that decide whether a number can be trusted as
 * a number of the HOST or is only what this container sees.
 *
 * Nothing here reads a file, calls Docker or knows the time, so every rule is
 * tested with fixtures. `collector.ts` does the reading.
 *
 * Why the sanity rules exist: Runway reads `/proc` and `statfs("/data")` from
 * inside the control container without extra privileges. In a plain Docker
 * container `/proc/meminfo` and `/proc/stat` are host-wide, and the data volume
 * lives on the host's Docker partition. That is an assumption that holds on a
 * normal install and breaks under lxcfs, in some sandboxes and when /data is a
 * tmpfs. A false reading is worse than none, so a reading that looks like the
 * container's own is shown grey as "Container view, not the host".
 */

// ── CPU ──────────────────────────────────────────────────────────

export interface CpuTimes {
  idle: number;
  total: number;
}

/** First "cpu " line of /proc/stat. idle + iowait count as idle. */
export function parseProcStat(text: string): CpuTimes | null {
  const line = text.split("\n").find((l) => /^cpu\s/.test(l));
  if (!line) return null;
  const n = line
    .trim()
    .split(/\s+/)
    .slice(1)
    .map((x) => Number(x));
  if (n.length < 4 || n.some((x) => !Number.isFinite(x) || x < 0)) return null;
  const idle = (n[3] ?? 0) + (n[4] ?? 0);
  // user nice system idle iowait irq softirq steal. guest and guest_nice are
  // already inside user and nice, so they are not added again.
  const total = n.slice(0, 8).reduce((a, b) => a + b, 0);
  return { idle, total };
}

/** Busy share, 0 to 100, between two readings; null when time did not advance. */
export function cpuPercent(prev: CpuTimes, cur: CpuTimes): number | null {
  const dTotal = cur.total - prev.total;
  const dIdle = cur.idle - prev.idle;
  if (!(dTotal > 0) || dIdle < 0) return null; // counter reset or no time passed
  const busy = (1 - dIdle / dTotal) * 100;
  return Math.min(100, Math.max(0, busy));
}

// ── Memory ───────────────────────────────────────────────────────

export interface MemInfo {
  totalBytes: number;
  availableBytes: number;
}

export function parseMeminfo(text: string): MemInfo | null {
  const kb = (key: string): number | null => {
    const m = text.match(new RegExp(`^${key}:\\s+(\\d+)\\s*kB`, "m"));
    return m ? Number(m[1]) * 1024 : null;
  };
  const total = kb("MemTotal");
  if (total === null || total <= 0) return null;
  let available = kb("MemAvailable");
  if (available === null) {
    // Kernels before 3.14: approximate what can be reclaimed.
    const free = kb("MemFree");
    const buffers = kb("Buffers") ?? 0;
    const cached = kb("Cached") ?? 0;
    if (free === null) return null;
    available = free + buffers + cached;
  }
  return { totalBytes: total, availableBytes: Math.min(available, total) };
}

/**
 * The memory limit of this container's cgroup, or null for "no limit".
 * cgroup v2 says "max"; v1 says a huge number (about 2^63) when unlimited.
 */
export function parseCgroupLimit(text: string | null): number | null {
  if (text === null) return null;
  const t = text.trim();
  if (t === "" || t === "max") return null;
  const n = Number(t);
  if (!Number.isFinite(n) || n <= 0) return null;
  if (n >= 2 ** 60) return null; // v1 "unlimited"
  return n;
}

export type View = "host" | "container";

export interface ViewVerdict {
  view: View;
  /** Why it looks like the container's own view; null for a host view. */
  reason: string | null;
}

/**
 * Does /proc/meminfo describe the machine or this container?
 *
 * A container with a memory limit but a host-wide /proc sees MemTotal larger
 * than its limit: that is normal and fine. A virtualised /proc (lxcfs, some
 * sandboxes) shows MemTotal equal to the limit: the numbers then describe the
 * container, not the host. So: a numeric limit that MemTotal does not exceed
 * (by more than 1%) means container view.
 */
export function judgeMemory(opts: { memTotalBytes: number; cgroupLimitBytes: number | null }): ViewVerdict {
  const { memTotalBytes, cgroupLimitBytes } = opts;
  if (cgroupLimitBytes !== null && memTotalBytes <= cgroupLimitBytes * 1.01) {
    return {
      view: "container",
      reason: `MemTotal (${Math.round(memTotalBytes / 2 ** 20)} MiB) is not larger than this container's memory limit (${Math.round(cgroupLimitBytes / 2 ** 20)} MiB): /proc looks virtualised`,
    };
  }
  return { view: "host", reason: null };
}

// ── Disk ─────────────────────────────────────────────────────────

/** Filesystem magic numbers of memory-backed filesystems (statfs f_type). */
const TMPFS = 0x01021994;
const RAMFS = 0x858458f6;

/** A data volume smaller than this is a scratch area, not the server's disk. */
export const MIN_HOST_DISK_BYTES = 2 ** 30;

export interface StatfsLike {
  type: number | bigint;
  bsize: number | bigint;
  blocks: number | bigint;
  bfree: number | bigint;
  bavail: number | bigint;
}

export interface DiskUsage {
  totalBytes: number;
  usedBytes: number;
  freeBytes: number;
  /** Used share like `df` prints it: used / (used + available), 0 to 100. */
  pct: number;
}

export function diskUsage(s: StatfsLike): DiskUsage | null {
  const bsize = Number(s.bsize);
  const blocks = Number(s.blocks);
  const bfree = Number(s.bfree);
  const bavail = Number(s.bavail);
  if (![bsize, blocks, bfree, bavail].every((x) => Number.isFinite(x) && x >= 0) || bsize === 0 || blocks === 0) {
    return null;
  }
  const totalBytes = blocks * bsize;
  const usedBytes = (blocks - bfree) * bsize;
  const freeBytes = bavail * bsize;
  const denom = usedBytes + freeBytes;
  const pct = denom > 0 ? (usedBytes / denom) * 100 : 0;
  return { totalBytes, usedBytes, freeBytes, pct: Math.min(100, Math.max(0, pct)) };
}

/** Is the data volume the server's disk, or a small or memory-backed area? */
export function judgeDisk(s: StatfsLike): ViewVerdict {
  const type = Number(s.type);
  if (type === TMPFS || type === RAMFS) {
    return { view: "container", reason: "the data volume is memory-backed (tmpfs or ramfs), not a disk" };
  }
  const total = Number(s.blocks) * Number(s.bsize);
  if (Number.isFinite(total) && total < MIN_HOST_DISK_BYTES) {
    return {
      view: "container",
      reason: `the data volume is only ${Math.round(total / 2 ** 20)} MiB in total, which is a scratch area and not the server's disk`,
    };
  }
  return { view: "host", reason: null };
}

// ── Docker: sizes ────────────────────────────────────────────────

export interface DockerUsage {
  imagesBytes: number;
  containersBytes: number;
  /** Volumes except the BuildKit cache volume (counted on its own). */
  volumesBytes: number;
  /** The size of the BuildKit cache volume as `docker system df` sees it, when it is there. */
  buildkitVolumeBytes: number | null;
  /** Docker's own build cache (not the BuildKit container's). */
  dockerBuildCacheBytes: number;
}

const BUILDKIT_VOLUME = /(^|[_-])buildkit-cache$/;

const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : null);
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const obj = (v: unknown): Record<string, unknown> => (v && typeof v === "object" ? (v as Record<string, unknown>) : {});

/**
 * `GET /system/df`. Two shapes exist: the long-standing one (Images, Containers,
 * Volumes, BuildCache arrays) and the newer one that reports a total per kind
 * (ImagesDiskUsage and so on). Both are read; a response that is neither gives
 * null and the caller says so instead of showing a zero.
 */
export function parseDf(resp: unknown): DockerUsage | null {
  const r = obj(resp);
  const hasOld = ["Images", "Containers", "Volumes", "BuildCache"].some((k) => k in r);
  const hasNew = ["ImagesDiskUsage", "ContainersDiskUsage", "VolumesDiskUsage", "BuildCacheDiskUsage"].some((k) => k in r);
  if (!hasOld && !hasNew) return null;

  let imagesBytes = 0;
  let containersBytes = 0;
  let volumesBytes = 0;
  let buildkitVolumeBytes: number | null = null;
  let dockerBuildCacheBytes = 0;

  if (hasOld) {
    // LayersSize is the real total of image layers; per-image Size repeats shared layers.
    imagesBytes = num(r.LayersSize) ?? arr(r.Images).reduce<number>((a, i) => a + (num(obj(i).Size) ?? 0), 0);
    containersBytes = arr(r.Containers).reduce<number>((a, c) => a + (num(obj(c).SizeRw) ?? 0), 0);
    for (const v of arr(r.Volumes)) {
      const o = obj(v);
      const size = num(obj(o.UsageData).Size); // -1 means "not computed": skipped
      if (size === null) continue;
      if (typeof o.Name === "string" && BUILDKIT_VOLUME.test(o.Name)) buildkitVolumeBytes = (buildkitVolumeBytes ?? 0) + size;
      else volumesBytes += size;
    }
    dockerBuildCacheBytes = arr(r.BuildCache).reduce<number>((a, b) => a + (num(obj(b).Size) ?? 0), 0);
  } else {
    imagesBytes = num(obj(r.ImagesDiskUsage).TotalSize) ?? 0;
    containersBytes = num(obj(r.ContainersDiskUsage).TotalSize) ?? 0;
    const vols = obj(r.VolumesDiskUsage);
    const items = arr(vols.Items);
    if (items.length > 0) {
      for (const v of items) {
        const o = obj(v);
        const size = num(obj(o.UsageData).Size);
        if (size === null) continue;
        if (typeof o.Name === "string" && BUILDKIT_VOLUME.test(o.Name)) buildkitVolumeBytes = (buildkitVolumeBytes ?? 0) + size;
        else volumesBytes += size;
      }
    } else {
      volumesBytes = num(vols.TotalSize) ?? 0;
    }
    dockerBuildCacheBytes = num(obj(r.BuildCacheDiskUsage).TotalSize) ?? 0;
  }
  return { imagesBytes, containersBytes, volumesBytes, buildkitVolumeBytes, dockerBuildCacheBytes };
}

// ── BuildKit: buildctl du ────────────────────────────────────────

const UNITS: Record<string, number> = {
  B: 1,
  KB: 1e3,
  MB: 1e6,
  GB: 1e9,
  TB: 1e12,
  PB: 1e15,
  KIB: 2 ** 10,
  MIB: 2 ** 20,
  GIB: 2 ** 30,
  TIB: 2 ** 40,
  PIB: 2 ** 50,
};

/** "1.5GB", "512MiB", "10.5kB", "0B", "3 MB" to bytes; null when it is not a size. */
export function parseSize(text: string): number | null {
  const m = text.trim().match(/^(\d+(?:\.\d+)?)\s*([kKMGTP]?i?[bB])$/);
  if (!m) return null;
  const unit = UNITS[m[2]!.toUpperCase()];
  if (unit === undefined) return null;
  return Math.round(Number(m[1]) * unit);
}

/**
 * The total of `buildctl du`: its "Total:" line, or when that is missing the
 * sum of the SIZE column. Null when the output has neither: the caller then
 * says the build cache is not included instead of showing a zero.
 */
export function parseBuildctlDu(text: string): number | null {
  const total = text.match(/^\s*Total:\s*(\S+)\s*$/m);
  if (total) {
    const n = parseSize(total[1]!);
    if (n !== null) return n;
  }
  const lines = text.split("\n");
  const header = lines.findIndex((l) => /\bSIZE\b/.test(l) && /\bID\b/.test(l));
  if (header === -1) return null;
  const cols = lines[header]!.trim().split(/\s{2,}|\t+/);
  const sizeIdx = cols.findIndex((c) => c === "SIZE");
  if (sizeIdx === -1) return null;
  let sum = 0;
  let rows = 0;
  const body = lines.slice(header + 1).filter((l) => l.trim() && !/^\s*(Reclaimable|Total):/.test(l));
  for (const l of body) {
    const cells = l.trim().split(/\s{2,}|\t+/);
    const n = parseSize(cells[sizeIdx] ?? "");
    if (n !== null) {
      sum += n;
      rows++;
    }
  }
  if (body.length === 0) return 0; // a header and nothing under it: an empty cache
  return rows > 0 ? sum : null;
}

// ── Time ─────────────────────────────────────────────────────────

/** "just now", "5 min ago", "3 h ago", "2 d ago". */
export function agoText(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 90) return "just now";
  const m = Math.round(s / 60);
  if (m < 90) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h} h ago`;
  return `${Math.round(h / 24)} d ago`;
}
