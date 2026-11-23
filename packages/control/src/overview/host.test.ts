/**
 * The server part of the overview: the Disk figure, the disk inbox items at 80
 * and 90 percent, CPU / memory / data statistics, the grey "Container view"
 * state, "No data yet", "measured N ago", and that an owner gets none of it.
 */
import { describe, expect, it } from "vitest";
import {
  DISK_CRIT_PCT,
  DISK_WARN_PCT,
  buildOverview,
  fillSeries,
  fmtBytes,
  ptsLine,
  type HostInput,
  type OverviewApp,
  type OverviewInput,
} from "./build.js";

const NOW = Date.UTC(2026, 10, 23, 12, 0, 0);
const MIN = 60_000;
const GB = 1e9;

const app = (id: string, name: string): OverviewApp => ({
  id,
  name,
  createdAt: NOW - 90 * 86_400_000,
  configured: true,
  state: "live",
  reason: null,
  ownerless: false,
});

const disk = (pct: number, over: Partial<NonNullable<HostInput["disk"]>> = {}): NonNullable<HostInput["disk"]> => {
  const total = 200 * GB;
  const used = (total * pct) / 100;
  return { totalBytes: total, usedBytes: used, freeBytes: total - used, pct, measuredAt: NOW - MIN, ...over };
};

const series = (avg: number | null, prevAvg: number | null, measuredAt: number | null = NOW - MIN) => ({
  avg,
  prevAvg,
  series: avg === null ? [null, null, null] : [avg - 2, null, avg],
  measuredAt,
});

const host = (over: Partial<HostInput> = {}): HostInput => ({
  procView: { view: "host", reason: null },
  diskView: { view: "host", reason: null },
  disk: disk(50),
  cpu: series(23, 20),
  mem: series(8 * GB, 7 * GB),
  memTotalBytes: 16 * GB,
  data: {
    totalBytes: 41.2 * GB,
    startBytes: 40 * GB,
    series: [40 * GB, null, 41.2 * GB],
    parts: { images: 20 * GB, volumes: 10 * GB, containers: 1.2 * GB, buildcache: 10 * GB },
    note: null,
    measuredAt: NOW - 3 * MIN,
  },
  errors: {},
  ...over,
});

const input = (over: Partial<OverviewInput> = {}): OverviewInput => ({
  viewer: { admin: true },
  apps: [app("a", "alpha")],
  kev: [],
  events: [],
  hits: new Map(),
  tokens: [],
  exemptions: [],
  nextRebuild: { kind: "at", at: NOW + 6 * 86_400_000, text: "Sun 29 Nov 05:00" },
  health: { total: 8, failed: [] },
  host: host(),
  ...over,
});

const fig = (v: ReturnType<typeof buildOverview>, key: string) => v.figures.find((f) => f.key === key);
const stat = (v: ReturnType<typeof buildOverview>, key: string) => v.stats.find((s) => s.key === key);
const item = (v: ReturnType<typeof buildOverview>, key: string) =>
  [...v.inbox.now, ...v.inbox.week, ...v.inbox.info].find((i) => i.key === key);

describe("helpers", () => {
  it("fmtBytes speaks decimal units like docker system df", () => {
    expect(fmtBytes(41.2e9)).toBe("41.2 GB");
    expect(fmtBytes(820e6)).toBe("820 MB");
    expect(fmtBytes(1.5e12)).toBe("1.5 TB");
    expect(fmtBytes(40_000)).toBe("40 kB");
    expect(fmtBytes(-1)).toBe("?");
    expect(fmtBytes(Number.NaN)).toBe("?");
  });

  it("fillSeries repeats the last value over a gap and starts flat at the first value", () => {
    expect(fillSeries([null, 5, null, 7, null])).toEqual([5, 5, 5, 7, 7]);
    expect(fillSeries([null, null])).toEqual([0, 0]);
    expect(fillSeries([])).toEqual([]);
  });

  it("ptsLine compares whole points and says when there is nothing to compare with", () => {
    expect(ptsLine(23, 20, "the previous 7 days")).toBe("+3 pts vs the previous 7 days");
    expect(ptsLine(20, 23, "the previous 7 days")).toBe("-3 pts vs the previous 7 days");
    expect(ptsLine(23.2, 22.8, "the previous 7 days")).toBe("no change vs the previous 7 days");
    expect(ptsLine(23, null, "the previous 7 days")).toBe("no earlier data");
  });
});

describe("the Disk figure (administrator)", () => {
  it("shows the share used and the space left, neutral below 80%", () => {
    const v = buildOverview(input({ host: host({ disk: disk(62.4) }) }), NOW);
    expect(fig(v, "disk")).toMatchObject({
      label: "Disk",
      value: "62%",
      sub: "75.2 GB free",
      tone: "neutral",
      href: "#server",
    });
    expect(fig(v, "disk")!.grey).toBeUndefined();
  });

  it("turns warm at 80% and red at 90%", () => {
    expect(DISK_WARN_PCT).toBe(80);
    expect(DISK_CRIT_PCT).toBe(90);
    expect(fig(buildOverview(input({ host: host({ disk: disk(79.9) }) }), NOW), "disk")!.tone).toBe("neutral");
    expect(fig(buildOverview(input({ host: host({ disk: disk(80) }) }), NOW), "disk")!.tone).toBe("warn");
    expect(fig(buildOverview(input({ host: host({ disk: disk(89.9) }) }), NOW), "disk")!.tone).toBe("warn");
    expect(fig(buildOverview(input({ host: host({ disk: disk(90) }) }), NOW), "disk")!.tone).toBe("err");
  });

  it("sits next to Health, which stays where it was", () => {
    const keys = buildOverview(input(), NOW).figures.map((f) => f.key);
    expect(keys).toEqual(["live", "down", "kev", "health", "disk"]);
  });

  it("says 'No data yet' with the reason as tooltip when there is no reading", () => {
    const v = buildOverview(input({ host: host({ disk: null, errors: { disk: "ENOENT: /data" } }) }), NOW);
    expect(fig(v, "disk")).toMatchObject({ value: "?", sub: "No data yet", grey: true, title: "ENOENT: /data" });
    expect(item(v, "disk-full")).toBeUndefined();
  });

  it("shows the number grey as 'Container view, not the host' instead of presenting it as the host's", () => {
    const v = buildOverview(
      input({ host: host({ disk: disk(97), diskView: { view: "container", reason: "the data volume is only 300 MiB" } }) }),
      NOW
    );
    expect(fig(v, "disk")).toMatchObject({
      grey: true,
      sub: "Container view, not the host",
      tone: "neutral", // 97% of a scratch volume is not an emergency
      title: "the data volume is only 300 MiB",
    });
  });

  it("says when the reading is old", () => {
    const v = buildOverview(input({ host: host({ disk: disk(50, { measuredAt: NOW - 40 * MIN }) }) }), NOW);
    expect(fig(v, "disk")!.sub).toBe("100.0 GB free, measured 40 min ago");
    const fresh = buildOverview(input({ host: host({ disk: disk(50, { measuredAt: NOW - 10 * MIN }) }) }), NOW);
    expect(fig(fresh, "disk")!.sub).toBe("100.0 GB free");
  });
});

describe("the disk in the inbox", () => {
  it("raises nothing below 80%", () => {
    const v = buildOverview(input({ host: host({ disk: disk(79) }) }), NOW);
    expect(item(v, "disk-full")).toBeUndefined();
    expect(v.headline.calm).toBe(true);
  });

  it("puts 80% in 'This week' and 90% in 'Needs you now', with a way to free space", () => {
    const warn = buildOverview(input({ host: host({ disk: disk(85) }) }), NOW);
    const w = item(warn, "disk-full")!;
    expect(w).toMatchObject({ urgency: "week", tone: "warn", title: "Server disk is 85% full", href: "/settings", action: "Free space" });
    expect(w.detail).toContain("30.0 GB free of 200.0 GB");
    expect(warn.inbox.week).toContain(w);

    const crit = buildOverview(input({ host: host({ disk: disk(95) }) }), NOW);
    const c = item(crit, "disk-full")!;
    expect(c).toMatchObject({ urgency: "now", tone: "err", title: "Server disk is 95% full" });
    expect(crit.inbox.now[0]).toBe(c); // a full disk comes first
    expect(crit.nowCount).toBe(1);
  });

  it("turns 'Everything is fine' into 'things need attention' when the disk is full", () => {
    const v = buildOverview(input({ host: host({ disk: disk(92) }) }), NOW);
    expect(v.headline.calm).toBe(false);
    expect(v.headline.text).toBe("1 thing needs attention");
  });

  it("raises no alarm for a container-view disk, only one quiet line", () => {
    const v = buildOverview(
      input({ host: host({ disk: disk(99), diskView: { view: "container", reason: "tmpfs" } }) }),
      NOW
    );
    expect(item(v, "disk-full")).toBeUndefined();
    const info = item(v, "disk-view")!;
    expect(info).toMatchObject({ urgency: "info", title: "Disk reading is not the host's" });
    expect(v.headline.calm).toBe(true);
    expect(v.nowCount).toBe(0);
  });
});

describe("CPU, memory and data statistics", () => {
  const stats = (h: HostInput, period: "24h" | "7d" | "30d" = "7d") => buildOverview(input({ host: h }), NOW, period);

  it("come after the existing statistics and are marked as server statistics", () => {
    const v = stats(host());
    expect(v.stats.map((s) => s.key)).toEqual(["apps", "deploys", "rebuilds", "kev", "hits", "cpu", "mem", "data"]);
    expect(v.stats.filter((s) => s.server).map((s) => s.key)).toEqual(["cpu", "mem", "data"]);
  });

  it("CPU: the period average with the difference in points", () => {
    const s = stat(stats(host()), "cpu")!;
    expect(s.display).toBe("23%");
    expect(s.deltaLine).toBe("+3 pts vs the previous 7 days");
    expect(s.series).toEqual([21, 21, 23]); // the gap repeats the last value
    expect(s.note).toBeNull();
    expect(s.grey).toBeFalsy();
  });

  it("CPU: says 'no earlier data' on a young install", () => {
    expect(stat(stats(host({ cpu: series(23, null) })), "cpu")!.deltaLine).toBe("no earlier data");
  });

  it("memory: the used share of MemTotal, the bytes underneath, and the difference in points", () => {
    const s = stat(stats(host()), "mem")!;
    expect(s.display).toBe("50%");
    expect(s.sub).toBe("8.0 GB of 16.0 GB");
    expect(s.deltaLine).toBe("+6 pts vs the previous 7 days"); // 43.75% -> 50%
  });

  it("memory: without MemTotal shows bytes and does not pretend to compare", () => {
    const s = stat(stats(host({ memTotalBytes: null })), "mem")!;
    expect(s.display).toBe("8.0 GB");
    expect(s.deltaLine).toBe("no comparison");
  });

  it("data: the total, growth over the period, and the parts as tooltip", () => {
    const s = stat(stats(host()), "data")!;
    expect(s.display).toBe("41.2 GB");
    expect(s.deltaLine).toBe("+1.2 GB in the last 7 days");
    expect(s.title).toBe("Images 20.0 GB, volumes 10.0 GB, containers 1.2 GB, build cache 10.0 GB");
  });

  it("data: shrinking, no change, and no earlier reading", () => {
    const base = host().data!;
    expect(stat(stats(host({ data: { ...base, startBytes: 45 * GB } })), "data")!.deltaLine).toBe("-3.8 GB in the last 7 days");
    expect(stat(stats(host({ data: { ...base, startBytes: 41.2 * GB } })), "data")!.deltaLine).toBe("no change in the last 7 days");
    expect(stat(stats(host({ data: { ...base, startBytes: null } })), "data")!.deltaLine).toBe("no earlier data");
  });

  it("data: carries the build-cache footnote", () => {
    const base = host().data!;
    const s = stat(stats(host({ data: { ...base, note: "BuildKit cache: buildctl du timed out; build cache not included" } })), "data")!;
    expect(s.sub).toBe("BuildKit cache: buildctl du timed out; build cache not included");
  });

  it("follows the period for its label", () => {
    expect(stat(stats(host(), "24h"), "cpu")!.deltaLine).toBe("+3 pts vs the previous 24 hours");
    expect(stat(stats(host(), "30d"), "data")!.deltaLine).toBe("+1.2 GB in the last 30 days");
  });

  it("CPU and memory are grey 'Container view, not the host' when /proc looks virtualised", () => {
    const v = stats(host({ procView: { view: "container", reason: "MemTotal equals the limit" } }));
    for (const key of ["cpu", "mem"]) {
      const s = stat(v, key)!;
      expect(s.grey).toBe(true);
      expect(s.note).toBe("Container view, not the host");
      expect(s.title).toBe("MemTotal equals the limit");
    }
    expect(stat(v, "data")!.grey).toBeFalsy(); // Docker's own numbers are the host's
  });

  it("says 'No data yet', with the reason, when nothing was measured", () => {
    const v = stats(host({ cpu: series(null, null, null), errors: { cpu: "EACCES: /proc/stat" }, data: null }));
    const cpu = stat(v, "cpu")!;
    expect(cpu).toMatchObject({ display: "—", note: "No data yet", grey: true, title: "EACCES: /proc/stat", series: [] });
    expect(stat(v, "data")).toMatchObject({ note: "No data yet", grey: true });
  });

  it("says when a reading is old (CPU after 12 minutes, data after 35)", () => {
    const old = host({
      cpu: series(23, 20, NOW - 30 * MIN),
      data: { ...host().data!, measuredAt: NOW - 50 * MIN },
    });
    const v = stats(old);
    expect(stat(v, "cpu")!.note).toBe("measured 30 min ago");
    expect(stat(v, "data")!.note).toBe("measured 50 min ago");
    const fresh = stats(host({ data: { ...host().data!, measuredAt: NOW - 20 * MIN } }));
    expect(stat(fresh, "data")!.note).toBeNull(); // data is only taken every 15 minutes
  });
});

describe("who gets server information", () => {
  it("is nobody but an administrator: an owner given a host input sees none of it", () => {
    const v = buildOverview(input({ viewer: { admin: false }, host: host({ disk: disk(99) }) }), NOW);
    expect(v.figures.map((f) => f.key)).toEqual(["live", "down", "kev", "expiring"]);
    expect(v.stats.map((s) => s.key)).toEqual(["apps", "deploys", "rebuilds", "kev", "hits"]);
    expect(item(v, "disk-full")).toBeUndefined();
    expect(item(v, "disk-view")).toBeUndefined();
    expect(v.headline.calm).toBe(true);
    const text = JSON.stringify(v);
    for (const leak of ["Disk", "disk", "CPU", "Memory", "Server disk", "GB", "Container view"]) {
      expect(text).not.toContain(leak);
    }
  });

  it("an administrator without a host input (collector off, or not asked) sees exactly what PR 1 showed", () => {
    for (const h of [undefined, null]) {
      const v = buildOverview(input({ host: h }), NOW);
      expect(v.figures.map((f) => f.key)).toEqual(["live", "down", "kev", "health"]);
      expect(v.stats.map((s) => s.key)).toEqual(["apps", "deploys", "rebuilds", "kev", "hits"]);
    }
  });
});
