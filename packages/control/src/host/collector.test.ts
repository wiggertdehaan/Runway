/**
 * The collector over fake files, a fake clock and a fake Docker: what it
 * stores, when it reads again, how it distrusts a reading that looks like the
 * container's own view, and how it fails (keeps the old numbers, says why).
 */
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { db, migrate } from "../db/index.js";
import {
  DATA_EVERY_MS,
  DISK_EVERY_MS,
  collectData,
  collectFast,
  resetCollector,
  startHostMetrics,
  type CollectorDeps,
} from "./collector.js";
import type { StatfsLike } from "./readings.js";
import { getState, latestSample } from "./store.js";

const T0 = Date.UTC(2026, 10, 23, 12, 0, 0);
const GiB = 2 ** 30;
const GB = 1e9;

const MEM_HOST = "MemTotal: 16777216 kB\nMemAvailable: 8388608 kB\n"; // 16 GiB, half free
const mem = (totalKb: number, availKb: number) => `MemTotal: ${totalKb} kB\nMemAvailable: ${availKb} kB\n`;
const stat = (idle: number, busy: number) => `cpu  ${busy} 0 0 ${idle} 0 0 0 0 0 0\ncpu0 1 1 1 1\n`;

const GOOD_DISK: StatfsLike = {
  type: 0xef53,
  bsize: 4096,
  blocks: (200 * GiB) / 4096,
  bfree: (90 * GiB) / 4096,
  bavail: (80 * GiB) / 4096,
};

const DF = {
  LayersSize: 10 * GB,
  Containers: [{ SizeRw: 1 * GB }],
  Volumes: [
    { Name: "runway_control-data", UsageData: { Size: 2 * GB } },
    { Name: "runway_buildkit-cache", UsageData: { Size: 5 * GB } },
  ],
  BuildCache: [{ Size: 1 * GB }],
};
const DU = "ID  RECLAIMABLE  SIZE  LAST ACCESSED\nsha256:a  true  3GB  now\nTotal:  3GB\n";

interface Rig {
  deps: CollectorDeps;
  files: Record<string, string | Error>;
  clock: { t: number };
  audits: Array<{ action: string; detail: string }>;
  log: { log: ReturnType<typeof vi.fn>; warn: ReturnType<typeof vi.fn>; error: ReturnType<typeof vi.fn> };
  disk: { v: StatfsLike | Error };
  df: { v: unknown | Error };
  du: { v: string | Error };
}

function rig(): Rig {
  const files: Rig["files"] = {
    "/proc/meminfo": MEM_HOST,
    "/proc/stat": stat(1000, 100),
    "/sys/fs/cgroup/memory.max": "max\n",
  };
  const clock = { t: T0 };
  const audits: Rig["audits"] = [];
  const log = { log: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const disk: Rig["disk"] = { v: GOOD_DISK };
  const df: Rig["df"] = { v: DF };
  const du: Rig["du"] = { v: DU };
  const deps: CollectorDeps = {
    readText: async (p) => {
      const f = files[p];
      if (f === undefined) throw new Error(`ENOENT ${p}`);
      if (f instanceof Error) throw f;
      return f;
    },
    statfs: async () => {
      if (disk.v instanceof Error) throw disk.v;
      return disk.v;
    },
    dataDir: "/data",
    df: async () => {
      if (df.v instanceof Error) throw df.v;
      return df.v;
    },
    buildDu: async () => {
      if (du.v instanceof Error) throw du.v;
      return du.v;
    },
    now: () => clock.t,
    audit: (action, detail) => audits.push({ action, detail }),
    log,
  };
  return { deps, files, clock, audits, log, disk, df, du };
}

beforeAll(() => migrate());

beforeEach(() => {
  db.exec("DELETE FROM host_metrics");
  db.exec("DELETE FROM host_state");
  resetCollector();
});

const count = (kind: string) =>
  (db.prepare("SELECT COUNT(*) AS n FROM host_metrics WHERE kind = ?").get(kind) as { n: number }).n;

describe("collectFast: what it stores", () => {
  it("stores memory and disk at once, but no CPU until it has two readings", async () => {
    const r = rig();
    await collectFast(r.deps);
    expect(latestSample("mem_used_bytes")!.value).toBe(8 * GiB);
    expect(getState("mem_total_bytes")).toBe(String(16 * GiB));
    expect(latestSample("disk_used_bytes")!.value).toBe(110 * GiB);
    expect(JSON.parse(getState("disk_last")!)).toMatchObject({ total: 200 * GiB, free: 80 * GiB });
    expect(latestSample("cpu_pct")).toBeNull();
  });

  it("stores the CPU share from the second reading on", async () => {
    const r = rig();
    await collectFast(r.deps);
    r.clock.t += 60_000;
    r.files["/proc/stat"] = stat(1300, 300); // 500 ticks: 200 busy, 300 idle
    await collectFast(r.deps);
    expect(latestSample("cpu_pct")!.value).toBeCloseTo(40, 5);
  });

  it("reads the disk every 5 minutes, memory and CPU every call", async () => {
    const r = rig();
    await collectFast(r.deps);
    r.clock.t += 60_000;
    r.files["/proc/stat"] = stat(1200, 150);
    await collectFast(r.deps);
    expect(count("disk_used_bytes")).toBe(1);
    r.clock.t += DISK_EVERY_MS;
    r.files["/proc/stat"] = stat(1400, 200);
    await collectFast(r.deps);
    // the first and the third call are 6 minutes apart: two disk buckets
    expect(count("disk_used_bytes")).toBe(2);
    expect(count("cpu_pct")).toBeGreaterThanOrEqual(1);
  });

  it("does not read the disk again within 5 minutes", async () => {
    const r = rig();
    const spy = vi.spyOn(r.deps, "statfs");
    await collectFast(r.deps);
    r.clock.t += 120_000;
    await collectFast(r.deps);
    r.clock.t += 120_000;
    await collectFast(r.deps);
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it("is a host reading on a normal machine: no audit line, no fuss", async () => {
    const r = rig();
    await collectFast(r.deps);
    await collectFast(r.deps);
    expect(r.audits).toEqual([]);
    expect(getState("view:mem")).toBe("host");
    expect(getState("view:disk")).toBe("host");
    expect(r.log.warn).not.toHaveBeenCalled();
  });
});

describe("collectFast: it distrusts a container view", () => {
  it("flags memory as the container's when MemTotal equals the cgroup limit; one log line, one audit line", async () => {
    const r = rig();
    r.files["/proc/meminfo"] = mem(2 * 1024 * 1024, 1024 * 1024); // 2 GiB total
    r.files["/sys/fs/cgroup/memory.max"] = String(2 * GiB);
    await collectFast(r.deps);
    r.clock.t += 60_000;
    await collectFast(r.deps);
    r.clock.t += 60_000;
    await collectFast(r.deps);
    expect(getState("view:mem")).toBe("container");
    expect(getState("reason:mem")).toMatch(/virtualised/);
    expect(r.audits).toHaveLength(1);
    expect(r.audits[0]!.action).toBe("host_metrics_container_view");
    expect(r.audits[0]!.detail).toMatch(/^mem: /);
    expect(r.log.warn.mock.calls.filter((c) => /container's view/.test(String(c[0])))).toHaveLength(1);
  });

  it("falls back to the cgroup v1 limit file", async () => {
    const r = rig();
    delete r.files["/sys/fs/cgroup/memory.max"];
    r.files["/sys/fs/cgroup/memory/memory.limit_in_bytes"] = String(16 * GiB);
    await collectFast(r.deps);
    expect(getState("view:mem")).toBe("container");
  });

  it("is still a host reading when the container has a limit below MemTotal", async () => {
    const r = rig();
    r.files["/sys/fs/cgroup/memory.max"] = String(2 * GiB);
    await collectFast(r.deps);
    expect(getState("view:mem")).toBe("host");
    expect(r.audits).toEqual([]);
  });

  it("flags a tiny data volume and a tmpfs as not the server's disk", async () => {
    const tiny = rig();
    tiny.disk.v = { ...GOOD_DISK, blocks: (300 * 2 ** 20) / 4096, bfree: 1000, bavail: 1000 };
    await collectFast(tiny.deps);
    expect(getState("view:disk")).toBe("container");
    expect(tiny.audits.map((a) => a.detail)).toEqual([expect.stringMatching(/^disk: .*300 MiB/)]);

    db.exec("DELETE FROM host_state");
    resetCollector();
    const tmp = rig();
    tmp.disk.v = { ...GOOD_DISK, type: 0x01021994 };
    await collectFast(tmp.deps);
    expect(getState("view:disk")).toBe("container");
    expect(getState("reason:disk")).toMatch(/memory-backed/);
  });

  it("audits again only when the verdict changes, and says when it is the host's again", async () => {
    const r = rig();
    r.files["/proc/meminfo"] = mem(2 * 1024 * 1024, 1024 * 1024);
    r.files["/sys/fs/cgroup/memory.max"] = String(2 * GiB);
    await collectFast(r.deps); // container: audit 1
    r.files["/sys/fs/cgroup/memory.max"] = "max\n";
    r.clock.t += 60_000;
    await collectFast(r.deps); // host again: no audit, one log line
    expect(getState("view:mem")).toBe("host");
    expect(getState("reason:mem")).toBeNull();
    expect(r.log.log.mock.calls.some((c) => /host's again/.test(String(c[0])))).toBe(true);
    r.files["/sys/fs/cgroup/memory.max"] = String(2 * GiB);
    r.clock.t += 60_000;
    await collectFast(r.deps); // container again: audit 2
    expect(r.audits).toHaveLength(2);
  });

  it("an audit failure never breaks the reading", async () => {
    const r = rig();
    r.files["/proc/meminfo"] = mem(2 * 1024 * 1024, 1024 * 1024);
    r.files["/sys/fs/cgroup/memory.max"] = String(2 * GiB);
    r.deps.audit = () => {
      throw new Error("audit table gone");
    };
    await expect(collectFast(r.deps)).resolves.toBeUndefined();
    expect(latestSample("mem_used_bytes")).not.toBeNull();
  });
});

describe("collectFast: no silent failure", () => {
  it("stores the reason for a reading it cannot take, keeps going with the others, and clears it later", async () => {
    const r = rig();
    r.files["/proc/stat"] = new Error("EACCES: /proc/stat");
    await expect(collectFast(r.deps)).resolves.toBeUndefined();
    expect(getState("err:cpu")).toMatch(/EACCES/);
    expect(latestSample("mem_used_bytes")).not.toBeNull(); // memory still measured
    expect(r.log.warn).toHaveBeenCalledTimes(1);
    r.clock.t += 60_000;
    await collectFast(r.deps); // same error again: not logged a second time
    expect(r.log.warn).toHaveBeenCalledTimes(1);
    r.files["/proc/stat"] = stat(1000, 100);
    r.clock.t += 60_000;
    await collectFast(r.deps);
    expect(getState("err:cpu")).toBeNull();
  });

  it("reports a disk it cannot read, and tries again on the next tick", async () => {
    const r = rig();
    r.disk.v = new Error("ENOENT /data");
    await collectFast(r.deps);
    expect(getState("err:disk")).toMatch(/ENOENT/);
    expect(getState("disk_last")).toBeNull();
    r.disk.v = GOOD_DISK;
    r.clock.t += 60_000; // far less than 5 minutes, but the last read failed: try again
    await collectFast(r.deps);
    expect(getState("err:disk")).toBeNull();
    expect(getState("disk_last")).not.toBeNull();
  });

  it("an empty /proc/meminfo is an error with a reason, not a zero", async () => {
    const r = rig();
    r.files["/proc/meminfo"] = "";
    await collectFast(r.deps);
    expect(getState("err:mem")).toMatch(/MemTotal/);
    expect(latestSample("mem_used_bytes")).toBeNull();
  });
});

describe("collectData", () => {
  it("stores images, containers and volumes, and counts the BuildKit cache once (buildctl du, not its volume)", async () => {
    const r = rig();
    await collectData(r.deps);
    expect(latestSample("data_images_bytes")!.value).toBe(10 * GB);
    expect(latestSample("data_containers_bytes")!.value).toBe(1 * GB);
    expect(latestSample("data_volumes_bytes")!.value).toBe(2 * GB); // the buildkit volume is not in here
    expect(latestSample("data_buildcache_bytes")!.value).toBe(1 * GB + 3 * GB); // Docker's + buildctl du
    expect(getState("data_note")).toBe("");
    expect(getState("err:data")).toBeNull();
  });

  it("estimates the BuildKit cache from its volume when buildctl du fails, and says so", async () => {
    const r = rig();
    r.du.v = new Error("buildctl du exit 1: container is not running");
    await collectData(r.deps);
    expect(latestSample("data_buildcache_bytes")!.value).toBe(1 * GB + 5 * GB);
    expect(getState("data_note")).toMatch(/estimated from its volume/);
  });

  it("leaves the BuildKit cache out, with a footnote, when neither is available", async () => {
    const r = rig();
    r.du.v = new Error("buildctl du timed out after 20s");
    r.df.v = { ...DF, Volumes: [{ Name: "runway_control-data", UsageData: { Size: 2 * GB } }] };
    await collectData(r.deps);
    expect(latestSample("data_buildcache_bytes")!.value).toBe(1 * GB); // Docker's own only
    expect(getState("data_note")).toMatch(/build cache not included/);
    expect(getState("data_note")).toMatch(/timed out/);
  });

  it("treats output it does not understand like a failure", async () => {
    const r = rig();
    r.du.v = "something new that is not a table\n";
    r.df.v = { ...DF, Volumes: [] };
    await collectData(r.deps);
    expect(getState("data_note")).toMatch(/does not know/);
    expect(getState("data_note")).toMatch(/not included/);
  });

  it("keeps the previous numbers when docker system df times out, and stores why", async () => {
    const r = rig();
    await collectData(r.deps);
    const before = latestSample("data_images_bytes")!;
    r.clock.t += DATA_EVERY_MS;
    r.df.v = new Error("docker system df timed out after 20s");
    await expect(collectData(r.deps)).resolves.toBeUndefined();
    expect(latestSample("data_images_bytes")).toEqual(before); // nothing new, nothing lost
    expect(getState("err:data")).toMatch(/timed out/);
    expect(r.log.warn).toHaveBeenCalled();
    r.clock.t += DATA_EVERY_MS;
    r.df.v = DF;
    await collectData(r.deps);
    expect(getState("err:data")).toBeNull();
    expect(latestSample("data_images_bytes")!.ts).toBeGreaterThan(before.ts);
  });

  it("says so when Docker answers in a shape it does not know", async () => {
    const r = rig();
    r.df.v = { message: "page not found" };
    await collectData(r.deps);
    expect(getState("err:data")).toMatch(/shape/);
    expect(latestSample("data_images_bytes")).toBeNull();
  });
});

describe("startHostMetrics", () => {
  it("is switched off by HOST_METRICS_INTERVAL_MS=0", () => {
    const log = { log: vi.fn(), warn: vi.fn(), error: vi.fn() };
    process.env.HOST_METRICS_INTERVAL_MS = "0";
    try {
      const stop = startHostMetrics(log);
      expect(log.log).toHaveBeenCalledWith(expect.stringMatching(/disabled/));
      expect(typeof stop).toBe("function");
      stop();
    } finally {
      delete process.env.HOST_METRICS_INTERVAL_MS;
    }
  });

  it("starts by default (every minute) and stops cleanly", () => {
    const log = { log: vi.fn(), warn: vi.fn(), error: vi.fn() };
    delete process.env.HOST_METRICS_INTERVAL_MS;
    const spy = vi.spyOn(globalThis, "setInterval");
    try {
      const stop = startHostMetrics(log);
      expect(log.log).toHaveBeenCalledWith(expect.stringMatching(/started/));
      expect(spy.mock.calls.map((c) => c[1])).toEqual([60_000, DATA_EVERY_MS]);
      stop();
    } finally {
      spy.mockRestore();
    }
  });

  it("uses the interval it is given, but never faster than every 5 seconds", () => {
    const log = { log: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const spy = vi.spyOn(globalThis, "setInterval");
    try {
      process.env.HOST_METRICS_INTERVAL_MS = "120000";
      startHostMetrics(log)();
      process.env.HOST_METRICS_INTERVAL_MS = "10";
      startHostMetrics(log)();
      expect(spy.mock.calls.map((c) => c[1])).toEqual([120_000, DATA_EVERY_MS, 5_000, DATA_EVERY_MS]);
    } finally {
      spy.mockRestore();
      delete process.env.HOST_METRICS_INTERVAL_MS;
    }
  });

  it("treats a typo as the default, not as 'off' and not as a timer of NaN", () => {
    const log = { log: vi.fn(), warn: vi.fn(), error: vi.fn() };
    process.env.HOST_METRICS_INTERVAL_MS = "abc";
    const spy = vi.spyOn(globalThis, "setInterval");
    try {
      const stop = startHostMetrics(log);
      expect(log.log).toHaveBeenCalledWith(expect.stringMatching(/started/));
      expect(log.log).not.toHaveBeenCalledWith(expect.stringMatching(/disabled/));
      expect(spy.mock.calls.map((c) => c[1])).toEqual([60_000, DATA_EVERY_MS]);
      stop();
    } finally {
      spy.mockRestore();
      delete process.env.HOST_METRICS_INTERVAL_MS;
    }
  });

  it("a negative number also turns it off", () => {
    const log = { log: vi.fn(), warn: vi.fn(), error: vi.fn() };
    process.env.HOST_METRICS_INTERVAL_MS = "-5";
    try {
      startHostMetrics(log)();
      expect(log.log).toHaveBeenCalledWith(expect.stringMatching(/disabled/));
    } finally {
      delete process.env.HOST_METRICS_INTERVAL_MS;
    }
  });
});
