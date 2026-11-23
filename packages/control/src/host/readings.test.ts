/**
 * The host-reading rules: parsers over fixtures of what the kernel and Docker
 * print, and the checks that decide whether a number is the host's.
 */
import { describe, expect, it } from "vitest";
import {
  MIN_HOST_DISK_BYTES,
  agoText,
  cpuPercent,
  diskUsage,
  judgeDisk,
  judgeMemory,
  parseBuildctlDu,
  parseCgroupLimit,
  parseDf,
  parseMeminfo,
  parseProcStat,
  parseSize,
} from "./readings.js";

const PROC_STAT = `cpu  4705 150 1120 16250 520 30 45 10 0 0
cpu0 1175 38 280 4062 130 8 11 2 0 0
intr 1462898 0 0
ctxt 3157484
`;

const MEMINFO = `MemTotal:       16384000 kB
MemFree:         2048000 kB
MemAvailable:    8192000 kB
Buffers:          512000 kB
Cached:          4096000 kB
SwapTotal:             0 kB
`;

describe("parseProcStat / cpuPercent", () => {
  it("reads the aggregate cpu line; idle includes iowait", () => {
    const t = parseProcStat(PROC_STAT)!;
    expect(t.idle).toBe(16250 + 520);
    expect(t.total).toBe(4705 + 150 + 1120 + 16250 + 520 + 30 + 45 + 10);
  });

  it("ignores the per-cpu lines and gives null for garbage", () => {
    expect(parseProcStat("cpu0 1 2 3 4\n")).toBeNull();
    expect(parseProcStat("")).toBeNull();
    expect(parseProcStat("cpu  a b c d\n")).toBeNull();
    expect(parseProcStat("cpu  1 2 3\n")).toBeNull();
  });

  it("is the busy share between two readings", () => {
    const a = { idle: 1000, total: 2000 };
    const b = { idle: 1500, total: 3000 }; // 1000 ticks passed, 500 idle
    expect(cpuPercent(a, b)).toBeCloseTo(50, 5);
    expect(cpuPercent(a, { idle: 1000, total: 3000 })).toBeCloseTo(100, 5);
    expect(cpuPercent(a, { idle: 2000, total: 3000 })).toBeCloseTo(0, 5);
  });

  it("gives null when no time passed or a counter went back", () => {
    const a = { idle: 1000, total: 2000 };
    expect(cpuPercent(a, a)).toBeNull();
    expect(cpuPercent(a, { idle: 500, total: 1500 })).toBeNull();
    expect(cpuPercent(a, { idle: 900, total: 2500 })).toBeNull(); // idle went back
  });
});

describe("parseMeminfo", () => {
  it("reads MemTotal and MemAvailable in bytes", () => {
    expect(parseMeminfo(MEMINFO)).toEqual({ totalBytes: 16384000 * 1024, availableBytes: 8192000 * 1024 });
  });

  it("approximates availability on an old kernel", () => {
    const old = "MemTotal: 1000 kB\nMemFree: 100 kB\nBuffers: 50 kB\nCached: 150 kB\n";
    expect(parseMeminfo(old)).toEqual({ totalBytes: 1000 * 1024, availableBytes: 300 * 1024 });
  });

  it("never reports more available than total, and null without MemTotal", () => {
    expect(parseMeminfo("MemTotal: 100 kB\nMemAvailable: 900 kB\n")!.availableBytes).toBe(100 * 1024);
    expect(parseMeminfo("MemFree: 100 kB\n")).toBeNull();
    expect(parseMeminfo("")).toBeNull();
  });
});

describe("parseCgroupLimit", () => {
  it("reads a number, and treats max, empty and the v1 'unlimited' as no limit", () => {
    expect(parseCgroupLimit("2147483648\n")).toBe(2147483648);
    expect(parseCgroupLimit("max\n")).toBeNull();
    expect(parseCgroupLimit("")).toBeNull();
    expect(parseCgroupLimit(null)).toBeNull();
    expect(parseCgroupLimit("9223372036854771712")).toBeNull();
    expect(parseCgroupLimit("nonsense")).toBeNull();
    expect(parseCgroupLimit("0")).toBeNull();
  });
});

describe("judgeMemory (the container-view check)", () => {
  const GiB = 2 ** 30;

  it("is the host when the container has no memory limit", () => {
    expect(judgeMemory({ memTotalBytes: 16 * GiB, cgroupLimitBytes: null })).toEqual({ view: "host", reason: null });
  });

  it("is the host when the limit is smaller than MemTotal: a limited container on a host-wide /proc", () => {
    expect(judgeMemory({ memTotalBytes: 16 * GiB, cgroupLimitBytes: 2 * GiB }).view).toBe("host");
  });

  it("is a container view when MemTotal equals the limit (a virtualised /proc)", () => {
    const v = judgeMemory({ memTotalBytes: 2 * GiB, cgroupLimitBytes: 2 * GiB });
    expect(v.view).toBe("container");
    expect(v.reason).toMatch(/virtualised/);
  });

  it("is a container view when MemTotal is even below the limit, and tolerates 1% rounding", () => {
    expect(judgeMemory({ memTotalBytes: GiB, cgroupLimitBytes: 4 * GiB }).view).toBe("container");
    expect(judgeMemory({ memTotalBytes: 2 * GiB * 1.005, cgroupLimitBytes: 2 * GiB }).view).toBe("container");
    expect(judgeMemory({ memTotalBytes: 2 * GiB * 1.2, cgroupLimitBytes: 2 * GiB }).view).toBe("host");
  });
});

describe("diskUsage / judgeDisk", () => {
  // 4 KiB blocks: 100 GiB total, 40 GiB free (root), 30 GiB available to us.
  const big = {
    type: 0xef53, // ext4
    bsize: 4096,
    blocks: (100 * 2 ** 30) / 4096,
    bfree: (40 * 2 ** 30) / 4096,
    bavail: (30 * 2 ** 30) / 4096,
  };

  it("counts used the way df does: used / (used + available)", () => {
    const u = diskUsage(big)!;
    expect(u.totalBytes).toBe(100 * 2 ** 30);
    expect(u.usedBytes).toBe(60 * 2 ** 30);
    expect(u.freeBytes).toBe(30 * 2 ** 30);
    expect(u.pct).toBeCloseTo((60 / 90) * 100, 5);
  });

  it("accepts bigint fields and rejects an empty answer", () => {
    expect(diskUsage({ type: 1n, bsize: 4096n, blocks: 1000n, bfree: 500n, bavail: 500n })!.pct).toBeCloseTo(50, 5);
    expect(diskUsage({ type: 1, bsize: 0, blocks: 0, bfree: 0, bavail: 0 })).toBeNull();
    expect(diskUsage({ type: 1, bsize: 4096, blocks: Number.NaN, bfree: 0, bavail: 0 })).toBeNull();
  });

  it("is the host for a normal partition", () => {
    expect(judgeDisk(big)).toEqual({ view: "host", reason: null });
  });

  it("is a container view for tmpfs and ramfs", () => {
    expect(judgeDisk({ ...big, type: 0x01021994 }).view).toBe("container");
    expect(judgeDisk({ ...big, type: 0x858458f6 }).view).toBe("container");
    expect(judgeDisk({ ...big, type: 0x01021994 }).reason).toMatch(/memory-backed/);
  });

  it("is a container view for a data volume smaller than 1 GiB", () => {
    const tiny = { ...big, blocks: (512 * 2 ** 20) / 4096, bfree: 1000, bavail: 1000 };
    const v = judgeDisk(tiny);
    expect(v.view).toBe("container");
    expect(v.reason).toMatch(/512 MiB/);
    expect(judgeDisk({ ...big, blocks: MIN_HOST_DISK_BYTES / 4096 }).view).toBe("host"); // exactly 1 GiB is fine
  });
});

describe("parseSize", () => {
  it("reads decimal and binary units", () => {
    expect(parseSize("1.5GB")).toBe(1_500_000_000);
    expect(parseSize("512MiB")).toBe(512 * 2 ** 20);
    expect(parseSize("10.5kB")).toBe(10_500);
    expect(parseSize("0B")).toBe(0);
    expect(parseSize("3 MB")).toBe(3_000_000);
    expect(parseSize("2.00GiB")).toBe(2 * 2 ** 30);
  });
  it("rejects what is not a size", () => {
    for (const bad of ["", "abc", "1.5", "GB", "-3MB", "1.5XB", "1,5GB"]) expect(parseSize(bad)).toBeNull();
  });
});

describe("parseBuildctlDu", () => {
  const OUT = `ID                                          RECLAIMABLE   SIZE         LAST ACCESSED
sha256:aaaa1111                             true          1.07GB       2 days ago
sha256:bbbb2222                             true          512MB        5 days ago
sha256:cccc3333*                            false         10.5kB       3 weeks ago
Reclaimable:  1.58GB
Total:        1.58GB
`;

  it("reads the Total line", () => {
    expect(parseBuildctlDu(OUT)).toBe(1_580_000_000);
    expect(parseBuildctlDu("Total:\t3.4GiB\n")).toBe(Math.round(3.4 * 2 ** 30));
  });

  it("sums the SIZE column when there is no Total line", () => {
    const noTotal = OUT.split("\n").filter((l) => !/^(Reclaimable|Total):/.test(l)).join("\n");
    expect(parseBuildctlDu(noTotal)).toBe(1_070_000_000 + 512_000_000 + 10_500);
  });

  it("is zero for an empty cache (a header and nothing under it) and null for unknown output", () => {
    expect(parseBuildctlDu("ID   RECLAIMABLE   SIZE   LAST ACCESSED\n")).toBe(0);
    expect(parseBuildctlDu("")).toBeNull();
    expect(parseBuildctlDu("error: something went wrong\n")).toBeNull();
    expect(parseBuildctlDu("ID  RECLAIMABLE  SIZE  LAST ACCESSED\nrow  true  lots  now\n")).toBeNull();
  });
});

describe("parseDf", () => {
  const GB = 1e9;

  it("reads the long-standing shape and counts the BuildKit volume on its own", () => {
    const resp = {
      LayersSize: 20 * GB,
      Images: [{ Size: 12 * GB }, { Size: 12 * GB }], // shared layers repeat: LayersSize wins
      Containers: [{ SizeRw: 1 * GB }, { SizeRw: 0.5 * GB }, {}],
      Volumes: [
        { Name: "runway_control-data", UsageData: { Size: 0.3 * GB, RefCount: 1 } },
        { Name: "runway_buildkit-cache", UsageData: { Size: 6 * GB, RefCount: 1 } },
        { Name: "app-data", UsageData: { Size: -1, RefCount: 0 } }, // not computed: skipped
      ],
      BuildCache: [{ Size: 1 * GB }, { Size: 2 * GB }],
    };
    expect(parseDf(resp)).toEqual({
      imagesBytes: 20 * GB,
      containersBytes: 1.5 * GB,
      volumesBytes: 0.3 * GB,
      buildkitVolumeBytes: 6 * GB,
      dockerBuildCacheBytes: 3 * GB,
    });
  });

  it("falls back to summing images when LayersSize is missing", () => {
    expect(parseDf({ Images: [{ Size: 5 }, { Size: 7 }] })!.imagesBytes).toBe(12);
  });

  it("reads the per-kind totals shape", () => {
    const resp = {
      ImagesDiskUsage: { TotalSize: 9 * GB },
      ContainersDiskUsage: { TotalSize: 1 * GB },
      VolumesDiskUsage: { TotalSize: 4 * GB },
      BuildCacheDiskUsage: { TotalSize: 2 * GB },
    };
    expect(parseDf(resp)).toEqual({
      imagesBytes: 9 * GB,
      containersBytes: 1 * GB,
      volumesBytes: 4 * GB,
      buildkitVolumeBytes: null,
      dockerBuildCacheBytes: 2 * GB,
    });
  });

  it("is null for an answer in a shape it does not know, instead of a silent zero", () => {
    expect(parseDf({})).toBeNull();
    expect(parseDf(null)).toBeNull();
    expect(parseDf("nope")).toBeNull();
    expect(parseDf({ message: "page not found" })).toBeNull();
  });
});

describe("agoText", () => {
  it("speaks in the unit that fits", () => {
    expect(agoText(30_000)).toBe("just now");
    expect(agoText(12 * 60_000)).toBe("12 min ago");
    expect(agoText(3 * 3_600_000)).toBe("3 h ago");
    expect(agoText(72 * 3_600_000)).toBe("3 d ago");
    expect(agoText(-5)).toBe("just now");
  });
});
