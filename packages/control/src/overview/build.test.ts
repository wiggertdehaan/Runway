/**
 * buildOverview: the figures, the inbox and the statistics, per role.
 * Pure data in, view out; no database, no clock.
 */
import { describe, expect, it } from "vitest";
import type { AtRiskApp } from "../routes/security-view.js";
import {
  PERIOD_SPECS,
  bucketize,
  buildOverview,
  makeDelta,
  parsePeriod,
  parseTime,
  sparkline,
  sumHourly,
  type OverviewApp,
  type OverviewEvent,
  type OverviewInput,
} from "./build.js";

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const NOW = Date.UTC(2026, 10, 23, 12, 0, 0);

const app = (id: string, over: Partial<OverviewApp> = {}): OverviewApp => ({
  id,
  name: id,
  createdAt: NOW - 100 * DAY,
  configured: true,
  state: "live",
  reason: null,
  ownerless: false,
  ...over,
});

const ev = (appId: string, code: string, ago: number): OverviewEvent => ({ appId, code, ts: NOW - ago });

const kevRow = (id: string, over: Partial<AtRiskApp> = {}): AtRiskApp => ({
  id,
  name: id,
  owner: null,
  state: "grace",
  cves: ["CVE-2026-1000"],
  deadline: new Date(NOW + 5 * DAY).toISOString(),
  quarantinedAt: null,
  exemptUntil: null,
  ...over,
});

const base = (over: Partial<OverviewInput> = {}): OverviewInput => ({
  viewer: { admin: true },
  apps: [],
  kev: [],
  events: [],
  hits: new Map(),
  tokens: [],
  exemptions: [],
  nextRebuild: { kind: "off" },
  health: null,
  ...over,
});

const titles = (items: { title: string }[]) => items.map((i) => i.title);
const allItems = (v: ReturnType<typeof buildOverview>) => [...v.inbox.now, ...v.inbox.week, ...v.inbox.info];

describe("parsePeriod / parseTime", () => {
  it("falls back to 7 days for anything unknown", () => {
    expect(parsePeriod("24h")).toBe("24h");
    expect(parsePeriod("30d")).toBe("30d");
    expect(parsePeriod("90d")).toBe("7d");
    expect(parsePeriod(undefined)).toBe("7d");
    expect(parsePeriod(["24h"])).toBe("7d");
  });

  it("reads SQLite and ISO times as UTC and rejects junk", () => {
    expect(parseTime("2026-11-23 12:00:00")).toBe(NOW);
    expect(parseTime("2026-11-23T12:00:00.000Z")).toBe(NOW);
    expect(parseTime("")).toBeNull();
    expect(parseTime(null)).toBeNull();
    expect(parseTime("not a date")).toBeNull();
  });
});

describe("makeDelta", () => {
  it("never divides by zero", () => {
    expect(makeDelta(0, 0, false, { percent: true })).toEqual({ text: "no change", fromZero: false, dir: "flat", bad: false });
    expect(makeDelta(5, 0, false, { percent: true })).toMatchObject({ text: "+5", fromZero: true });
    expect(makeDelta(0, 4, false, { percent: true }).text).toBe("-100%");
  });

  it("is a percentage only when asked, and 'bad' only when up is bad", () => {
    expect(makeDelta(15, 10, false, { percent: true })).toEqual({ text: "+50%", fromZero: false, dir: "up", bad: false });
    expect(makeDelta(3, 1, false).text).toBe("+2");
    expect(makeDelta(3, 1, true).bad).toBe(true);
    expect(makeDelta(1, 3, true)).toEqual({ text: "-2", fromZero: false, dir: "down", bad: false });
  });
});

describe("bucketize / sumHourly", () => {
  it("puts the newest time in the last bucket and ignores what is out of range", () => {
    const out = bucketize([NOW - 1, NOW - HOUR - 1, NOW - 3 * HOUR, NOW - 30 * HOUR, NOW + 5], NOW, HOUR, 4);
    expect(out).toEqual([1, 0, 1, 1]);
  });

  it("sums hourly counts into day buckets, newest last, missing history as zero", () => {
    const hourly = new Array(48).fill(1); // two days of 1 per hour
    expect(sumHourly(hourly, 0, 24, 2)).toEqual([24, 24]);
    expect(sumHourly(hourly, 0, 24, 3)).toEqual([0, 24, 24]);
    expect(sumHourly(hourly, 24, 24, 1)).toEqual([24]);
    expect(sumHourly([], 0, 24, 2)).toEqual([0, 0]);
  });
});

describe("sparkline", () => {
  it("draws finite numbers for an empty, a flat and a normal series", () => {
    for (const series of [[], [0, 0, 0], [3], [1, 4, 2, 9]]) {
      const svg = sparkline(series, "x");
      expect(svg).toContain("<polyline");
      expect(svg).not.toMatch(/NaN|Infinity/);
    }
  });

  it("escapes its title", () => {
    expect(sparkline([1], `a"<b>&`)).not.toMatch(/<b>/);
  });
});

describe("figures", () => {
  it("counts live and down apps, and the KEV list", () => {
    const v = buildOverview(
      base({
        apps: [
          app("a"),
          app("b"),
          app("c", { state: "failed" }),
          app("d", { state: "offline" }),
          app("e", { configured: false, state: "stopped" }),
        ],
        kev: [kevRow("a"), kevRow("d", { state: "quarantined" })],
      }),
      NOW
    );
    const f = Object.fromEntries(v.figures.map((x) => [x.key, x]));
    expect(f.live).toMatchObject({ value: "2", sub: "of 4", href: "/" });
    expect(f.down).toMatchObject({ value: "2", tone: "err" });
    expect(f.kev).toMatchObject({ value: "2", tone: "err", href: "/security" });
  });

  it("gives an administrator Health and an owner Expiring, never both", () => {
    const admin = buildOverview(base({ health: { total: 8, failed: [] } }), NOW);
    expect(admin.figures.map((f) => f.key)).toEqual(["live", "down", "kev", "health"]);
    expect(admin.figures[3]).toMatchObject({ value: "OK", tone: "ok" });

    const bad = buildOverview(base({ health: { total: 8, failed: ["Docker", "Traefik"] } }), NOW);
    expect(bad.figures[3]).toMatchObject({ value: "2 issues", tone: "err", href: "/health" });

    const owner = buildOverview(base({ viewer: { admin: false } }), NOW);
    expect(owner.figures.map((f) => f.key)).toEqual(["live", "down", "kev", "expiring"]);
    expect(JSON.stringify(owner.figures)).not.toMatch(/health|Health|disk|Disk|CPU/);
  });

  it("counts tokens and exemptions that end within 7 days for the owner's 'Expiring'", () => {
    const v = buildOverview(
      base({
        viewer: { admin: false },
        apps: [app("a")],
        tokens: [
          { kind: "user", expiresAt: NOW + 2 * DAY },
          { kind: "developer", expiresAt: NOW + 40 * DAY },
          { kind: "user", expiresAt: NOW - DAY }, // already over: not "expiring"
          { kind: "developer", expiresAt: null },
        ],
        exemptions: [{ appId: "a", until: NOW + 6 * DAY }],
      }),
      NOW
    );
    expect(v.figures[3]).toMatchObject({ key: "expiring", value: "2", tone: "warn" });
  });
});

describe("inbox", () => {
  it("is empty and calm when nothing is wrong, with the next rebuild", () => {
    const v = buildOverview(
      base({ apps: [app("a")], nextRebuild: { kind: "at", at: NOW + 3 * DAY, text: "Sun 29 Nov 05:00" } }),
      NOW
    );
    expect(allItems(v)).toEqual([]);
    expect(v.headline).toMatchObject({ calm: true, text: "Everything is fine" });
    expect(v.nextRebuild).toEqual({ kind: "at", at: NOW + 3 * DAY, text: "Sun 29 Nov 05:00" });
    expect(v.nowCount).toBe(0);
  });

  it("is not 'Everything is fine' while a server component fails", () => {
    const v = buildOverview(base({ apps: [app("a")], health: { total: 8, failed: ["Docker"] } }), NOW);
    expect(v.headline.calm).toBe(false);
    expect(v.headline.text).toBe("Your apps are fine");
    expect(v.headline.sub).toContain("Docker");
  });

  it("puts an offline app first, then the nearest deadline, and links to the right place", () => {
    const v = buildOverview(
      base({
        apps: [app("far"), app("near"), app("gone", { state: "offline" })],
        kev: [
          kevRow("far", { deadline: new Date(NOW + 6 * DAY).toISOString() }),
          kevRow("near", { deadline: new Date(NOW + 2 * DAY).toISOString() }),
          kevRow("gone", { state: "quarantined", quarantinedAt: new Date(NOW - DAY).toISOString(), deadline: null }),
        ],
      }),
      NOW
    );
    expect(titles(v.inbox.now)).toEqual(["gone is offline", "near goes offline in 2d"]);
    expect(titles(v.inbox.week)).toEqual(["far goes offline in 6d"]);
    expect(v.inbox.now[0]).toMatchObject({ tone: "err", href: "/apps/gone#quarantine", action: "Fix it" });
    expect(v.nowCount).toBe(2);
    expect(v.headline).toMatchObject({ calm: false, text: "3 things need attention" });
  });

  it("does not list an app twice when it is both down and in a KEV term", () => {
    const v = buildOverview(
      base({ apps: [app("x", { state: "offline" })], kev: [kevRow("x", { state: "quarantined", deadline: null })] }),
      NOW
    );
    expect(allItems(v).filter((i) => i.appId === "x")).toHaveLength(1);
  });

  it("lists a crashed app with the reason, and nothing for a stopped one", () => {
    const v = buildOverview(
      base({ apps: [app("c", { state: "failed", reason: "Crash loop" }), app("s", { state: "stopped" })] }),
      NOW
    );
    expect(v.inbox.now).toHaveLength(1);
    expect(v.inbox.now[0]).toMatchObject({ title: "c is not running", detail: "Crash loop", href: "/apps/c" });
  });

  it("reports a failed last deploy: now within a day, this week after that, gone when a later deploy worked", () => {
    const recent = buildOverview(base({ apps: [app("a")], events: [ev("a", "deploy_failed:scan_blocked", 2 * HOUR)] }), NOW);
    expect(titles(recent.inbox.now)).toEqual(["The last deploy of a was stopped by the security scan"]);

    const older = buildOverview(base({ apps: [app("a")], events: [ev("a", "deploy_failed:build", 3 * DAY)] }), NOW);
    expect(titles(older.inbox.week)).toEqual(["The last deploy of a failed while building"]);

    const fixed = buildOverview(
      base({ apps: [app("a")], events: [ev("a", "deploy_failed:build", 3 * DAY), ev("a", "deploy_succeeded", 2 * DAY)] }),
      NOW
    );
    expect(allItems(fixed)).toEqual([]);

    const old = buildOverview(base({ apps: [app("a")], events: [ev("a", "deploy_failed:build", 9 * DAY)] }), NOW);
    expect(allItems(old)).toEqual([]);
  });

  it("reports a rebuild that did not take, to an admin at /rebuild and to an owner at the app", () => {
    const events = [ev("a", "rebuild_rolled_back", DAY)];
    const admin = buildOverview(base({ apps: [app("a")], events }), NOW);
    expect(admin.inbox.week[0]).toMatchObject({ href: "/rebuild" });
    expect(admin.inbox.week[0]!.title).toContain("previous version was restored");
    const owner = buildOverview(base({ viewer: { admin: false }, apps: [app("a")], events }), NOW);
    expect(owner.inbox.week[0]).toMatchObject({ href: "/apps/a" });

    const healed = buildOverview(
      base({ apps: [app("a")], events: [ev("a", "rebuild_failed", 2 * DAY), ev("a", "deploy_succeeded", DAY)] }),
      NOW
    );
    expect(allItems(healed).filter((i) => i.key.startsWith("rebuild:"))).toEqual([]);
  });

  it("puts dependency news in the right group", () => {
    const v = buildOverview(
      base({
        apps: [app("a")],
        events: [ev("a", "deps_updated", 2 * DAY), ev("a", "major_available", 2 * DAY), ev("a", "deps_rolled_back", HOUR)],
      }),
      NOW
    );
    expect(v.inbox.week.map((i) => i.key)).toEqual(["deps-rb:a"]);
    expect(v.inbox.info.map((i) => i.key).sort()).toEqual(["major:a", "updated:a"]);
  });

  it("warns about an exemption that ends within 3 days, not later ones or expired ones", () => {
    const v = buildOverview(
      base({
        apps: [app("a"), app("b"), app("c")],
        exemptions: [
          { appId: "a", until: NOW + 2 * DAY },
          { appId: "b", until: NOW + 10 * DAY },
          { appId: "c", until: NOW - DAY },
        ],
      }),
      NOW
    );
    expect(titles(v.inbox.week)).toEqual(["The exemption for a ends in 2d"]);
  });

  it("warns about tokens that run out within 7 days, with the right link per role", () => {
    const tokens = [
      { kind: "user" as const, expiresAt: NOW + 3 * DAY },
      { kind: "developer" as const, expiresAt: NOW + 20 * DAY },
    ];
    const admin = buildOverview(base({ tokens }), NOW);
    expect(admin.inbox.week[0]).toMatchObject({ key: "tokens", href: "/users", title: "1 access token runs out within 7 days" });
    const owner = buildOverview(base({ viewer: { admin: false }, tokens }), NOW);
    expect(owner.inbox.week[0]).toMatchObject({ href: "/account", action: "Renew" });
    expect(buildOverview(base({ tokens: [{ kind: "user", expiresAt: NOW + 30 * DAY }] }), NOW).inbox.week).toEqual([]);
  });

  it("tells only an administrator about apps without an owner", () => {
    const apps = [app("o1", { ownerless: true }), app("o2", { ownerless: true }), app("mine")];
    const admin = buildOverview(base({ apps }), NOW);
    expect(admin.inbox.info[0]).toMatchObject({ key: "ownerless", title: "2 apps have no owner" });
    // an owner is never given an ownerless app, but even if one slipped in, they are not told
    const owner = buildOverview(base({ viewer: { admin: false }, apps }), NOW);
    expect(allItems(owner).some((i) => i.key === "ownerless")).toBe(false);
  });

  it("caps a long group and says how many more there are", () => {
    const apps = Array.from({ length: 40 }, (_, i) => app(`a${String(i).padStart(2, "0")}`, { state: "failed" }));
    const v = buildOverview(base({ apps }), NOW);
    expect(v.inbox.now).toHaveLength(30);
    expect(v.more.now).toBe(10);
    expect(v.nowCount).toBe(40);
  });
});

describe("what an owner can never see", () => {
  it("drops events, hits, KEV rows and exemptions of apps that are not in the list", () => {
    const mine = app("mine");
    const input = base({
      viewer: { admin: false },
      apps: [mine],
      kev: [kevRow("mine"), kevRow("theirs", { cves: ["CVE-2026-9999"] })],
      events: [
        ev("mine", "deploy_succeeded", HOUR),
        ev("theirs", "deploy_succeeded", HOUR),
        ev("theirs", "deploy_failed:build", HOUR),
        ev("theirs", "kev_grace_started", HOUR),
        ev("theirs", "major_available", HOUR),
      ],
      hits: new Map([
        ["mine", new Array(2880).fill(1)],
        ["theirs", new Array(2880).fill(1000)],
      ]),
      exemptions: [{ appId: "theirs", until: NOW + DAY }],
    });
    const v = buildOverview(input, NOW, "24h");
    const dump = JSON.stringify(v);
    expect(dump).not.toContain("theirs");
    expect(dump).not.toContain("CVE-2026-9999");
    const stat = (k: string) => v.stats.find((s) => s.key === k)!;
    expect(stat("deploys").value).toBe(1);
    expect(stat("deploys").sub).toBeNull();
    expect(stat("kev").value).toBe(0);
    expect(stat("hits").value).toBe(24); // 24 hours x 1, not x 1000
    expect(v.topApps).toEqual([{ id: "mine", name: "mine", hits: 24 }]);
    expect(v.figures.find((f) => f.key === "kev")!.value).toBe("1");
  });

  it("an owner without apps gets an empty, calm overview", () => {
    const v = buildOverview(base({ viewer: { admin: false } }), NOW);
    expect(v.headline.calm).toBe(true);
    expect(v.figures.map((f) => f.value)).toEqual(["0", "0", "0", "0"]);
    expect(v.topApps).toEqual([]);
  });
});

describe("statistics", () => {
  const events = [
    // current 7 days
    ev("a", "deploy_succeeded", HOUR),
    ev("a", "deploy_succeeded", 2 * DAY),
    ev("a", "deploy_failed:build", 3 * DAY),
    ev("a", "rebuild_rebuilt", DAY),
    ev("a", "rebuild_failed", 4 * DAY),
    ev("a", "kev_grace_started", 5 * DAY),
    ev("a", "kev_added", 6 * DAY),
    ev("a", "kev_deadline_7d", 6 * DAY), // a countdown, not a new finding
    // previous 7 days
    ev("a", "deploy_succeeded", 9 * DAY),
    ev("a", "kev_grace_started", 10 * DAY),
    // older than both
    ev("a", "deploy_succeeded", 20 * DAY),
  ];
  const stat = (v: ReturnType<typeof buildOverview>, k: string) => v.stats.find((s) => s.key === k)!;

  it("counts deploys, rebuilds and new KEV findings in the period against the one before", () => {
    const v = buildOverview(base({ apps: [app("a")], events }), NOW, "7d");
    expect(stat(v, "deploys")).toMatchObject({ value: 2, sub: "1 failed", subBad: true });
    expect(stat(v, "deploys").delta).toMatchObject({ text: "+1", dir: "up", bad: false });
    expect(stat(v, "rebuilds")).toMatchObject({ value: 1, sub: "1 failed" });
    expect(stat(v, "kev").value).toBe(2);
    expect(stat(v, "kev").delta).toMatchObject({ text: "+1", bad: true });
    expect(stat(v, "deploys").series).toHaveLength(7);
    expect(stat(v, "deploys").series.reduce((a, b) => a + b, 0)).toBe(2);
  });

  it("changes with the period: 24 hours sees only the last day, 30 days sees the older deploy", () => {
    const day = buildOverview(base({ apps: [app("a")], events }), NOW, "24h");
    expect(stat(day, "deploys").value).toBe(1);
    expect(stat(day, "deploys").series).toHaveLength(24);
    const month = buildOverview(base({ apps: [app("a")], events }), NOW, "30d");
    expect(stat(month, "deploys").value).toBe(4);
    expect(stat(month, "deploys").series).toHaveLength(30);
  });

  it("counts new apps by creation time", () => {
    const apps = [app("old"), app("new1", { createdAt: NOW - DAY }), app("new2", { createdAt: NOW - 3 * DAY })];
    const v = buildOverview(base({ apps }), NOW, "7d");
    expect(stat(v, "apps").value).toBe(2);
    expect(stat(v, "apps").delta).toMatchObject({ text: "+2", fromZero: true });
  });

  it("sums hits over the period, compares with the one before, and names the top three", () => {
    const hourly = (cur: number, prev: number, hours: number) => [
      ...new Array(2880 - 2 * hours).fill(0),
      ...new Array(hours).fill(prev),
      ...new Array(hours).fill(cur),
    ];
    const apps = [app("a"), app("b"), app("c"), app("d"), app("quiet")];
    const hits = new Map([
      ["a", hourly(10, 5, 24)],
      ["b", hourly(30, 0, 24)],
      ["c", hourly(20, 0, 24)],
      ["d", hourly(1, 0, 24)],
      ["quiet", hourly(0, 0, 24)],
    ]);
    const v = buildOverview(base({ apps, hits }), NOW, "24h");
    expect(stat(v, "hits").value).toBe((10 + 30 + 20 + 1) * 24);
    expect(stat(v, "hits").delta).toMatchObject({ dir: "up" });
    expect(stat(v, "hits").delta.text).toMatch(/^\+\d+%$/);
    expect(v.topApps.map((t) => t.id)).toEqual(["b", "c", "a"]);
    expect(stat(v, "hits").series).toHaveLength(24);
  });

  it("tolerates apps with no hit history at all", () => {
    const v = buildOverview(base({ apps: [app("a")] }), NOW, "30d");
    expect(stat(v, "hits")).toMatchObject({ value: 0 });
    expect(stat(v, "hits").delta.text).toBe("no change");
    expect(v.topApps).toEqual([]);
  });

  it("has a spec for every period and the sparkline length matches it", () => {
    for (const p of ["24h", "7d", "30d"] as const) {
      const v = buildOverview(base({ apps: [app("a")] }), NOW, p);
      expect(v.period).toBe(PERIOD_SPECS[p]);
      for (const s of v.stats) expect(s.series).toHaveLength(PERIOD_SPECS[p].buckets);
    }
  });
});
