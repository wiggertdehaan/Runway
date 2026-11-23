/**
 * The overview page's brain: one pure function that turns what Runway already
 * knows (apps, KEV terms, events, hits, tokens, exemptions) into the four
 * figures, the inbox ("Now", "This week", "For your information") and the
 * "This" statistics of a period.
 *
 * Pure on purpose: no database, no Docker, no clock. `gather.ts` and the route
 * read the sources; everything that decides what is shown, in which order and
 * with which numbers lives here, so it is testable per role.
 *
 * Who may see what is decided BEFORE this runs (the caller passes only the
 * apps the viewer may see, from `appsVisibleTo`) and enforced AGAIN here:
 * every event, hit series, exemption and KEV row whose app is not in
 * `input.apps` is dropped, so a caller that passes too much cannot leak it.
 * Tokens are the one thing not tied to an app: the caller passes an admin all
 * tokens and an owner only their own.
 */
import { fmtCountdown, offlineAt, URGENT_MS, type AtRiskApp } from "../routes/security-view.js";
import { agoText, type View } from "../host/readings.js";
import type { AppState } from "../ui/status.js";

// ── Periods ──────────────────────────────────────────────────────

export type Period = "24h" | "7d" | "30d";
export const PERIODS: readonly Period[] = ["24h", "7d", "30d"];
export const DEFAULT_PERIOD: Period = "7d";

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

export interface PeriodSpec {
  key: Period;
  /** "24 hours", "7 days". */
  label: string;
  /** "the previous 24 hours". */
  previous: string;
  hours: number;
  /** Number of sparkline buckets and the hours each covers. */
  buckets: number;
  bucketHours: number;
}

export const PERIOD_SPECS: Record<Period, PeriodSpec> = {
  "24h": { key: "24h", label: "24 hours", previous: "the previous 24 hours", hours: 24, buckets: 24, bucketHours: 1 },
  "7d": { key: "7d", label: "7 days", previous: "the previous 7 days", hours: 7 * 24, buckets: 7, bucketHours: 24 },
  "30d": { key: "30d", label: "30 days", previous: "the previous 30 days", hours: 30 * 24, buckets: 30, bucketHours: 24 },
};

/** Unknown or missing input falls back to the default instead of failing. */
export function parsePeriod(value: unknown): Period {
  return value === "24h" || value === "7d" || value === "30d" ? value : DEFAULT_PERIOD;
}

/** The hits history the overview needs: this period and the one before it. */
export const HITS_HISTORY_HOURS = 2 * 30 * 24;

// ── Input ────────────────────────────────────────────────────────

export interface OverviewApp {
  id: string;
  name: string | null;
  /** Epoch ms the app was created. */
  createdAt: number;
  /** Has a name and runtime (was configured at least once). */
  configured: boolean;
  state: AppState;
  /** Short reason for a failed/offline state ("Crash loop"), from the status model. */
  reason: string | null;
  /** True for an app nobody owns (admin-only). Only the administrator is told about it. */
  ownerless: boolean;
}

export interface OverviewEvent {
  appId: string;
  /** Epoch ms. */
  ts: number;
  code: string;
}

export interface OverviewToken {
  kind: "user" | "developer";
  /** Epoch ms, or null for "never expires". */
  expiresAt: number | null;
}

export interface OverviewExemption {
  appId: string;
  /** Epoch ms the exemption ends. */
  until: number;
}

export type NextRebuild =
  | { kind: "off" }
  | { kind: "due" }
  | { kind: "at"; at: number; text: string };

export interface HealthSummary {
  total: number;
  failed: string[];
}

/** One host figure the page may show: the reading, whether it is the host's, and when it was taken. */
export interface HostSeries {
  /** Mean over the current period; null when nothing was measured in it. */
  avg: number | null;
  /** Mean over the period before it; null when there is no history that far back. */
  prevAvg: number | null;
  /** One value per sparkline bucket, null where nothing was measured. */
  series: Array<number | null>;
  /** Epoch ms of the newest sample; null when there is none. */
  measuredAt: number | null;
}

export interface HostDisk {
  totalBytes: number;
  usedBytes: number;
  freeBytes: number;
  /** Used share, 0 to 100, the way `df` prints it. */
  pct: number;
  measuredAt: number;
}

export interface HostData {
  totalBytes: number;
  /** The same total at the start of the period; null when there was no sample that old. */
  startBytes: number | null;
  series: Array<number | null>;
  parts: { images: number; volumes: number; containers: number; buildcache: number };
  /** A caveat about the build-cache part ("build cache not included"). */
  note: string | null;
  measuredAt: number;
}

/**
 * What the host collector measured, already cut to the period. Administrators
 * only: `buildOverview` ignores it for anybody else.
 */
export interface HostInput {
  /** CPU and memory come from /proc; one verdict for both. */
  procView: { view: View; reason: string | null };
  diskView: { view: View; reason: string | null };
  disk: HostDisk | null;
  cpu: HostSeries;
  mem: HostSeries;
  memTotalBytes: number | null;
  data: HostData | null;
  /** Why a reading is missing ("No data yet" with the reason as its tooltip). */
  errors: { disk?: string; cpu?: string; mem?: string; data?: string };
}

export interface OverviewInput {
  viewer: { admin: boolean };
  /** Only the apps the viewer may see. */
  apps: OverviewApp[];
  /** KEV terms of those apps. */
  kev: AtRiskApp[];
  /** Events of the last 2 x 30 days. */
  events: OverviewEvent[];
  /**
   * Hourly request counts per app, oldest first, ending at the current hour,
   * `HITS_HISTORY_HOURS` long (shorter arrays are treated as zero-padded at the old end).
   */
  hits: Map<string, number[]>;
  tokens: OverviewToken[];
  exemptions: OverviewExemption[];
  nextRebuild: NextRebuild;
  /** Administrator only; null when not asked or not available. */
  health: HealthSummary | null;
  /** Administrator only: host disk, CPU, memory and data. Absent or null shows nothing. */
  host?: HostInput | null;
}

// ── Output ───────────────────────────────────────────────────────

export type Tone = "ok" | "warn" | "err" | "neutral";

export interface Figure {
  key: "live" | "down" | "kev" | "health" | "disk" | "expiring";
  label: string;
  value: string;
  sub: string | null;
  tone: Tone;
  href: string;
  /** Not the host's number (a container view) or not measured: shown in grey. */
  grey?: boolean;
  /** Tooltip, e.g. why there is no data. */
  title?: string;
}

export type Urgency = "now" | "week" | "info";

export interface InboxItem {
  /** Stable key, for tests and for the DOM. */
  key: string;
  urgency: Urgency;
  tone: "err" | "warn" | "info";
  title: string;
  detail: string | null;
  href: string;
  /** The one button of the row. */
  action: string;
  appId: string | null;
  /** Sort key inside a group: smaller first. */
  rank: number;
}

export interface Delta {
  /** "+3", "-2", "+12%", "no change". */
  text: string;
  /** The previous period had none, so a difference says nothing: the text is just "+N". */
  fromZero: boolean;
  dir: "up" | "down" | "flat";
  /** True when the direction is bad news for this statistic and it moved that way. */
  bad: boolean;
}

export interface Stat {
  key: "apps" | "deploys" | "rebuilds" | "kev" | "hits" | "cpu" | "mem" | "data";
  label: string;
  value: number;
  /** The value as shown ("23%", "41.2 GB"); the number itself when absent. */
  display?: string;
  /** The whole "difference" line, when the usual "N vs the previous period" does not fit. */
  deltaLine?: string;
  /** Small grey line: "Container view, not the host", "measured 12 min ago", "No data yet". */
  note?: string | null;
  grey?: boolean;
  /** Tooltip. */
  title?: string;
  /** Server statistics: only an administrator gets them. */
  server?: boolean;
  /** Second line, e.g. "2 failed". */
  sub: string | null;
  subBad: boolean;
  delta: Delta;
  series: number[];
}

export interface TopApp {
  id: string;
  name: string;
  hits: number;
}

export interface OverviewView {
  period: PeriodSpec;
  headline: { calm: boolean; text: string; sub: string; healthIssues: string[] };
  figures: Figure[];
  inbox: { now: InboxItem[]; week: InboxItem[]; info: InboxItem[] };
  /** Items beyond the display cap, per group. */
  more: { now: number; week: number; info: number };
  stats: Stat[];
  topApps: TopApp[];
  nextRebuild: NextRebuild;
  /** Number of "now" items: what a sidebar counter would show. */
  nowCount: number;
}

// ── Small pure helpers ───────────────────────────────────────────

const GROUP_CAP = 30;

/** Parse "2026-11-23 10:00:00" (SQLite, UTC) or an ISO string; null when it is neither. */
export function parseTime(value: string | null | undefined): number | null {
  if (!value) return null;
  const iso = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(value) ? value.replace(" ", "T") + "Z" : value;
  const t = Date.parse(iso);
  return Number.isFinite(t) ? t : null;
}

function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

function nameOf(a: OverviewApp): string {
  return a.name ?? a.id;
}

/** "in 3d", "in 5h", "in 12m" for something that ends `ms` from now. */
function inText(ms: number): string {
  return fmtCountdown(Math.max(0, ms));
}

/**
 * Count timestamps per bucket. The last bucket ends at `now`, each covers
 * `bucketMs`; anything outside the covered range is ignored. Oldest first.
 */
export function bucketize(times: number[], now: number, bucketMs: number, count: number): number[] {
  const out = new Array<number>(count).fill(0);
  for (const t of times) {
    const age = now - t;
    if (age < 0 || age >= bucketMs * count) continue;
    out[count - 1 - Math.floor(age / bucketMs)]!++;
  }
  return out;
}

/**
 * Sum an hourly series (oldest first, ending at the current hour) into
 * `count` buckets of `bucketHours`, taking the window that ends at the end of
 * the array shifted back by `skipHours`. Missing history counts as zero.
 */
export function sumHourly(hourly: number[], skipHours: number, bucketHours: number, count: number): number[] {
  const out = new Array<number>(count).fill(0);
  const end = hourly.length - skipHours;
  for (let b = 0; b < count; b++) {
    const to = end - (count - 1 - b) * bucketHours;
    const from = to - bucketHours;
    let sum = 0;
    for (let i = Math.max(0, from); i < Math.min(hourly.length, to); i++) sum += hourly[i] ?? 0;
    out[b] = sum;
  }
  return out;
}

/** Difference to the previous period, in words. Division by zero never happens. */
export function makeDelta(current: number, previous: number, badWhenUp: boolean, opts: { percent?: boolean } = {}): Delta {
  const diff = current - previous;
  if (diff === 0) return { text: "no change", fromZero: false, dir: "flat", bad: false };
  const dir = diff > 0 ? "up" : "down";
  const sign = diff > 0 ? "+" : "-";
  let text: string;
  if (previous === 0) {
    text = `+${current}`;
  } else if (opts.percent) {
    text = `${sign}${Math.round((Math.abs(diff) / previous) * 100)}%`;
  } else {
    text = `${sign}${Math.abs(diff)}`;
  }
  return { text, fromZero: previous === 0 && current > 0, dir, bad: badWhenUp && dir === "up" };
}

const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);

// ── Host figures ─────────────────────────────────────────────────

/** Disk fullness at which the inbox speaks: "This week" from the first, "Needs you now" from the second. */
export const DISK_WARN_PCT = 80;
export const DISK_CRIT_PCT = 90;

/** How old a reading may be before the page says when it was taken. */
const STALE_FAST_MS = 12 * 60_000; // CPU, memory: one sample a minute
const STALE_DISK_MS = 17 * 60_000; // every 5 minutes
const STALE_DATA_MS = 35 * 60_000; // every 15 minutes

/** Bytes as the host tools print them in SI units: 1.5 GB, 820 MB. */
export function fmtBytes(n: number): string {
  if (!Number.isFinite(n) || n < 0) return "?";
  if (n >= 1e12) return `${(n / 1e12).toFixed(1)} TB`;
  if (n >= 1e9) return `${(n / 1e9).toFixed(1)} GB`;
  if (n >= 1e6) return `${Math.round(n / 1e6)} MB`;
  return `${Math.round(n / 1e3)} kB`;
}

/** A series with gaps for a sparkline: a gap repeats the last value (0 before the first). */
export function fillSeries(values: Array<number | null>): number[] {
  const out: number[] = [];
  let last = 0;
  const firstReal = values.find((v) => v !== null);
  if (typeof firstReal === "number") last = firstReal; // a leading gap starts flat at the first value
  for (const v of values) {
    if (v !== null) last = v;
    out.push(last);
  }
  return out;
}

function staleNote(now: number, measuredAt: number | null, maxAge: number): string | null {
  return measuredAt !== null && now - measuredAt > maxAge ? `measured ${agoText(now - measuredAt)}` : null;
}

const noDelta: Delta = { text: "", fromZero: false, dir: "flat", bad: false };

/** "+3 pts vs the previous 7 days", or why there is no comparison. */
export function ptsLine(cur: number, prev: number | null, previousLabel: string): string {
  if (prev === null) return "no earlier data";
  const diff = Math.round(cur) - Math.round(prev);
  if (diff === 0) return `no change vs ${previousLabel}`;
  return `${diff > 0 ? "+" : "-"}${Math.abs(diff)} pts vs ${previousLabel}`;
}

function diskFigure(host: HostInput, now: number): Figure {
  const d = host.disk;
  if (!d) {
    return {
      key: "disk",
      label: "Disk",
      value: "?",
      sub: "No data yet",
      tone: "neutral",
      href: "#server",
      grey: true,
      title: host.errors.disk ?? "The first reading comes within a few minutes of a start.",
    };
  }
  const pct = Math.round(d.pct);
  if (host.diskView.view === "container") {
    return {
      key: "disk",
      label: "Disk",
      value: `${pct}%`,
      sub: "Container view, not the host",
      tone: "neutral",
      href: "#server",
      grey: true,
      title: host.diskView.reason ?? undefined,
    };
  }
  const stale = staleNote(now, d.measuredAt, STALE_DISK_MS);
  return {
    key: "disk",
    label: "Disk",
    value: `${pct}%`,
    sub: `${fmtBytes(d.freeBytes)} free${stale ? `, ${stale}` : ""}`,
    tone: d.pct >= DISK_CRIT_PCT ? "err" : d.pct >= DISK_WARN_PCT ? "warn" : "neutral",
    href: "#server",
  };
}

function missingStat(key: Stat["key"], label: string, reason: string | undefined): Stat {
  return {
    key,
    label,
    value: 0,
    display: "\u2014",
    sub: null,
    subBad: false,
    note: "No data yet",
    grey: true,
    title: reason ?? "The first reading comes within a few minutes of a start.",
    delta: noDelta,
    series: [],
    server: true,
  };
}

/** CPU, memory and Docker data: administrators only (the caller checks). */
function serverStats(host: HostInput, spec: PeriodSpec, now: number): Stat[] {
  const out: Stat[] = [];
  const procGrey = host.procView.view === "container";
  const containerNote = "Container view, not the host";

  // CPU, a share of the host.
  if (host.cpu.avg === null) {
    out.push(missingStat("cpu", "CPU", host.errors.cpu));
  } else {
    out.push({
      key: "cpu",
      label: "CPU",
      value: Math.round(host.cpu.avg),
      display: `${Math.round(host.cpu.avg)}%`,
      sub: null,
      subBad: false,
      note: procGrey ? containerNote : staleNote(now, host.cpu.measuredAt, STALE_FAST_MS),
      grey: procGrey,
      title: procGrey ? (host.procView.reason ?? undefined) : "Average over the period",
      delta: noDelta,
      deltaLine: ptsLine(host.cpu.avg, host.cpu.prevAvg, spec.previous),
      series: fillSeries(host.cpu.series),
      server: true,
    });
  }

  // Memory, used share of the host (MemTotal - MemAvailable).
  const total = host.memTotalBytes;
  if (host.mem.avg === null) {
    out.push(missingStat("mem", "Memory", host.errors.mem));
  } else {
    const toPct = (b: number) => (total ? (b / total) * 100 : b);
    const pct = toPct(host.mem.avg);
    out.push({
      key: "mem",
      label: "Memory",
      value: Math.round(pct),
      display: total ? `${Math.round(pct)}%` : fmtBytes(host.mem.avg),
      sub: total ? `${fmtBytes(host.mem.avg)} of ${fmtBytes(total)}` : null,
      subBad: false,
      note: procGrey ? containerNote : staleNote(now, host.mem.measuredAt, STALE_FAST_MS),
      grey: procGrey,
      title: procGrey ? (host.procView.reason ?? undefined) : "Used memory, average over the period",
      delta: noDelta,
      deltaLine: total
        ? ptsLine(pct, host.mem.prevAvg === null ? null : toPct(host.mem.prevAvg), spec.previous)
        : "no comparison",
      series: fillSeries(host.mem.series),
      server: true,
    });
  }

  // Docker data: images + volumes + containers + build cache, in decimal GB like `docker system df`.
  const data = host.data;
  if (!data) {
    out.push(missingStat("data", "Data", host.errors.data));
  } else {
    const diff = data.startBytes === null ? null : data.totalBytes - data.startBytes;
    const small = diff !== null && Math.abs(diff) < Math.max(1e7, data.totalBytes * 0.005);
    const deltaLine =
      diff === null
        ? "no earlier data"
        : small
          ? `no change in the last ${spec.label}`
          : `${diff > 0 ? "+" : "-"}${fmtBytes(Math.abs(diff))} in the last ${spec.label}`;
    const p = data.parts;
    out.push({
      key: "data",
      label: "Data",
      value: Math.round(data.totalBytes / 1e9),
      display: fmtBytes(data.totalBytes),
      sub: data.note,
      subBad: false,
      note: staleNote(now, data.measuredAt, STALE_DATA_MS),
      title: `Images ${fmtBytes(p.images)}, volumes ${fmtBytes(p.volumes)}, containers ${fmtBytes(p.containers)}, build cache ${fmtBytes(p.buildcache)}`,
      delta: noDelta,
      deltaLine,
      series: fillSeries(data.series),
      server: true,
    });
  }
  return out;
}

// ── Event phrases ────────────────────────────────────────────────

const DEPLOY_FAIL_PHRASE: Record<string, string> = {
  "deploy_failed:build": "failed while building",
  "deploy_failed:scan_blocked": "was stopped by the security scan",
  "deploy_failed:unhealthy": "did not become healthy",
  "deploy_failed:preflight": "was refused by the pre-deploy checks",
  "deploy_failed:other": "failed",
};

const REBUILD_BAD_PHRASE: Record<string, string> = {
  rebuild_failed: "failed",
  rebuild_rolled_back: "did not start cleanly, so the previous version was restored",
  rebuild_blocked: "was blocked by the security scan, the previous version keeps running",
};

const DEPLOY_CODES = new Set(["deploy_succeeded", "deploy_rolled_back", ...Object.keys(DEPLOY_FAIL_PHRASE)]);
const REBUILD_OK = "rebuild_rebuilt";
const REBUILD_BAD = new Set(Object.keys(REBUILD_BAD_PHRASE));
const KEV_NEW = new Set(["kev_grace_started", "kev_added"]);

// ── The builder ──────────────────────────────────────────────────

export function buildOverview(input: OverviewInput, now: number, period: Period = DEFAULT_PERIOD): OverviewView {
  const spec = PERIOD_SPECS[period];
  const admin = input.viewer.admin;

  // Everything below works on these: nothing about an app that is not in the list.
  const apps = input.apps;
  const byId = new Map(apps.map((a) => [a.id, a]));
  const kev = input.kev.filter((k) => byId.has(k.id));
  const events = input.events.filter((e) => byId.has(e.appId)).sort((a, b) => a.ts - b.ts);
  const exemptions = input.exemptions.filter((x) => byId.has(x.appId) && x.until > now);

  // ── Inbox ──
  const items: InboxItem[] = [];
  const add = (i: Omit<InboxItem, "rank"> & { rank?: number }) => items.push({ rank: 0, ...i });
  const kevIds = new Set(kev.map((k) => k.id));

  for (const k of kev) {
    const app = byId.get(k.id)!;
    const name = nameOf(app);
    const cves = k.cves.slice(0, 3).join(", ") + (k.cves.length > 3 ? `, +${k.cves.length - 3} more` : "");
    const href = `/apps/${encodeURIComponent(k.id)}#quarantine`;
    if (k.state === "quarantined") {
      add({
        key: `kev:${k.id}`,
        urgency: "now",
        tone: "err",
        title: `${name} is offline`,
        detail: `Taken offline: an actively exploited vulnerability was not fixed in time (${cves}). It comes back by itself once a rebuild or deploy fixes it.`,
        href,
        action: "Fix it",
        appId: k.id,
        rank: 0,
      });
      continue;
    }
    const at = offlineAt(k);
    const left = at === null ? null : at - now;
    const urgent = left !== null && left < 3 * DAY;
    add({
      key: `kev:${k.id}`,
      urgency: left === null || urgent ? "now" : "week",
      tone: left !== null && left < URGENT_MS ? "err" : "warn",
      title: left === null ? `${name} goes offline unless it is fixed` : `${name} goes offline ${inText(left)}`,
      detail: `Actively exploited vulnerability: ${cves}. A rebuild or a new deploy with fixed dependencies clears it.`,
      href,
      action: "Fix it",
      appId: k.id,
      rank: 1 + (left ?? Number.MAX_SAFE_INTEGER / 4) / DAY,
    });
  }

  for (const app of apps) {
    if (kevIds.has(app.id)) continue; // the KEV row says more than "is down"
    if (app.state === "failed" || app.state === "offline") {
      add({
        key: `down:${app.id}`,
        urgency: "now",
        tone: "err",
        title: `${nameOf(app)} is ${app.state === "offline" ? "offline" : "not running"}`,
        detail: app.reason,
        href: `/apps/${encodeURIComponent(app.id)}`,
        action: "Open",
        appId: app.id,
        rank: 0.5,
      });
    }
  }

  // Latest event per app per family, to know what the last word was.
  const lastOf = (appId: string, pred: (code: string) => boolean): OverviewEvent | undefined => {
    let found: OverviewEvent | undefined;
    for (const e of events) if (e.appId === appId && pred(e.code)) found = e;
    return found;
  };

  for (const app of apps) {
    const name = nameOf(app);
    const id = encodeURIComponent(app.id);

    // The last deploy went wrong and nothing good came after it.
    const dep = lastOf(app.id, (c) => DEPLOY_CODES.has(c));
    if (dep && dep.code in DEPLOY_FAIL_PHRASE && now - dep.ts < 7 * DAY) {
      const recent = now - dep.ts < DAY;
      add({
        key: `deploy:${app.id}`,
        urgency: recent ? "now" : "week",
        tone: "warn",
        title: `The last deploy of ${name} ${DEPLOY_FAIL_PHRASE[dep.code]}`,
        detail: "The version that was running before keeps running.",
        href: `/apps/${id}`,
        action: "Open",
        appId: app.id,
        rank: 2 + (now - dep.ts) / DAY / 100,
      });
    }

    // A rebuild that did not take, unless a later rebuild or deploy fixed it.
    const reb = lastOf(app.id, (c) => c === REBUILD_OK || REBUILD_BAD.has(c));
    if (reb && REBUILD_BAD.has(reb.code) && now - reb.ts < 7 * DAY) {
      const later = events.some((e) => e.appId === app.id && e.ts > reb.ts && e.code === "deploy_succeeded");
      if (!later) {
        add({
          key: `rebuild:${app.id}`,
          urgency: "week",
          tone: "warn",
          title: `The rebuild of ${name} ${REBUILD_BAD_PHRASE[reb.code]}`,
          detail: null,
          href: admin ? "/rebuild" : `/apps/${id}`,
          action: "Open",
          appId: app.id,
          rank: 3 + (now - reb.ts) / DAY / 100,
        });
      }
    }

    // A dependency update that was not kept.
    const dr = lastOf(app.id, (c) => c === "deps_rolled_back" || c === "deps_updated");
    if (dr && dr.code === "deps_rolled_back" && now - dr.ts < 7 * DAY) {
      add({
        key: `deps-rb:${app.id}`,
        urgency: "week",
        tone: "warn",
        title: `A dependency update for ${name} did not work and was not kept`,
        detail: "The app keeps running on the old dependencies.",
        href: `/apps/${id}#maintenance`,
        action: "Open",
        appId: app.id,
        rank: 4 + (now - dr.ts) / DAY / 100,
      });
    }

    // Information: a major update is possible; things that were fixed.
    const major = lastOf(app.id, (c) => c === "major_available");
    if (major && now - major.ts < 14 * DAY) {
      add({
        key: `major:${app.id}`,
        urgency: "info",
        tone: "info",
        title: `A newer major version would fix a vulnerability in ${name}`,
        detail: "Major updates are never applied automatically. You can allow them per app.",
        href: `/apps/${id}#maintenance`,
        action: "Review",
        appId: app.id,
        rank: 10 + (now - major.ts) / DAY,
      });
    }
    const upd = lastOf(app.id, (c) => c === "deps_updated" || c === "auto_minor_applied");
    if (upd && now - upd.ts < 3 * DAY) {
      add({
        key: `updated:${app.id}`,
        urgency: "info",
        tone: "info",
        title: `${name} was updated to fix a vulnerability`,
        detail: null,
        href: `/apps/${id}`,
        action: "Open",
        appId: app.id,
        rank: 11 + (now - upd.ts) / DAY,
      });
    }
    const res = lastOf(app.id, (c) => c === "kev_resolved");
    if (res && now - res.ts < 3 * DAY && !kevIds.has(app.id)) {
      add({
        key: `resolved:${app.id}`,
        urgency: "info",
        tone: "info",
        title: `${name} is no longer at risk`,
        detail: "The actively exploited vulnerability is fixed.",
        href: `/apps/${id}#quarantine`,
        action: "Open",
        appId: app.id,
        rank: 12 + (now - res.ts) / DAY,
      });
    }
    const exp = lastOf(app.id, (c) => c === "exemption_expired");
    if (exp && now - exp.ts < 3 * DAY) {
      add({
        key: `exempt-ended:${app.id}`,
        urgency: "info",
        tone: "info",
        title: `The exemption for ${name} has ended`,
        detail: null,
        href: `/apps/${id}#quarantine`,
        action: "Open",
        appId: app.id,
        rank: 13 + (now - exp.ts) / DAY,
      });
    }
  }

  // Exemptions that end soon.
  for (const x of exemptions) {
    const left = x.until - now;
    if (left > 3 * DAY) continue;
    const app = byId.get(x.appId)!;
    add({
      key: `exempt:${x.appId}`,
      urgency: "week",
      tone: "warn",
      title: `The exemption for ${nameOf(app)} ends ${inText(left)}`,
      detail: "After that the countdown for the actively exploited vulnerability continues.",
      href: `/apps/${encodeURIComponent(x.appId)}#quarantine`,
      action: "Open",
      appId: x.appId,
      rank: 5 + left / DAY,
    });
  }

  // Tokens that run out within a week (the viewer's own; an administrator sees everybody's).
  const soon = input.tokens.filter((t) => t.expiresAt !== null && t.expiresAt > now && t.expiresAt - now <= 7 * DAY);
  if (soon.length > 0) {
    const earliest = Math.min(...soon.map((t) => t.expiresAt as number));
    add({
      key: "tokens",
      urgency: "week",
      tone: "warn",
      title: admin
        ? `${plural(soon.length, "access token", "access tokens")} ${soon.length === 1 ? "runs" : "run"} out within 7 days`
        : `${plural(soon.length, "access token", "access tokens")} of yours ${soon.length === 1 ? "runs" : "run"} out within 7 days`,
      detail: `The first one ${inText(earliest - now)}. Make a new one before then, or the agent using it loses access.`,
      href: admin ? "/users" : "/account",
      action: admin ? "See tokens" : "Renew",
      appId: null,
      rank: 6 + (earliest - now) / DAY,
    });
  }

  // Apps nobody owns: administrators only, and not urgent.
  if (admin) {
    const orphans = apps.filter((a) => a.ownerless && a.configured);
    if (orphans.length > 0) {
      const first = orphans[0]!;
      add({
        key: "ownerless",
        urgency: "info",
        tone: "info",
        title:
          orphans.length === 1
            ? `${nameOf(first)} has no owner`
            : `${orphans.length} apps have no owner`,
        detail: "Only administrators can see and manage them. Give each one an owner on its Config tab.",
        href: orphans.length === 1 ? `/apps/${encodeURIComponent(first.id)}` : "/",
        action: orphans.length === 1 ? "Assign" : "See apps",
        appId: null,
        rank: 20,
      });
    }
  }

  // The server's disk: "This week" from 80%, "Needs you now" from 90%. A reading
  // that is only the container's own view is not trusted either way: one quiet line.
  const host = admin ? (input.host ?? null) : null;
  if (host && host.disk) {
    const d = host.disk;
    if (host.diskView.view === "container") {
      add({
        key: "disk-view",
        urgency: "info",
        tone: "info",
        title: "Disk reading is not the host's",
        detail:
          "Runway can only see its own data volume here, so the server's disk is not shown. Check the host itself with: df -h /",
        href: "/health",
        action: "See health",
        appId: null,
        rank: 21,
      });
    } else if (d.pct >= DISK_WARN_PCT) {
      const critical = d.pct >= DISK_CRIT_PCT;
      add({
        key: "disk-full",
        urgency: critical ? "now" : "week",
        tone: critical ? "err" : "warn",
        title: `Server disk is ${Math.round(d.pct)}% full`,
        detail: `${fmtBytes(d.freeBytes)} free of ${fmtBytes(d.totalBytes)}. Builds and deploys fail when it is full. Pruning the build cache is the quickest way to free space.`,
        href: "/settings",
        action: "Free space",
        appId: null,
        rank: critical ? 0.2 : 7,
      });
    }
  }

  const sorted = (urgency: Urgency) =>
    items
      .filter((i) => i.urgency === urgency)
      .sort((a, b) => a.rank - b.rank || a.title.localeCompare(b.title));
  const nowAll = sorted("now");
  const weekAll = sorted("week");
  const infoAll = sorted("info");
  const inbox = {
    now: nowAll.slice(0, GROUP_CAP),
    week: weekAll.slice(0, GROUP_CAP),
    info: infoAll.slice(0, GROUP_CAP),
  };
  const more = {
    now: Math.max(0, nowAll.length - GROUP_CAP),
    week: Math.max(0, weekAll.length - GROUP_CAP),
    info: Math.max(0, infoAll.length - GROUP_CAP),
  };

  // ── Figures ──
  const configured = apps.filter((a) => a.configured);
  const live = configured.filter((a) => a.state === "live").length;
  const down = configured.filter((a) => a.state === "failed" || a.state === "offline").length;
  const offlineKev = kev.filter((k) => k.state === "quarantined").length;
  const figures: Figure[] = [
    {
      key: "live",
      label: "Apps live",
      value: String(live),
      sub: configured.length > 0 ? `of ${configured.length}` : null,
      tone: configured.length > 0 && live === configured.length ? "ok" : "neutral",
      href: "/",
    },
    {
      key: "down",
      label: "Down",
      value: String(down),
      sub: null,
      tone: down > 0 ? "err" : "neutral",
      href: "/",
    },
    {
      key: "kev",
      label: "KEV risk",
      value: String(kev.length),
      sub: kev.length > 0 ? (offlineKev > 0 ? `${offlineKev} offline` : "countdown running") : null,
      tone: offlineKev > 0 ? "err" : kev.length > 0 ? "warn" : "neutral",
      href: "/security",
    },
  ];
  if (admin) {
    const h = input.health;
    figures.push(
      h
        ? {
            key: "health",
            label: "Health",
            value: h.failed.length === 0 ? "OK" : `${h.failed.length} issue${h.failed.length === 1 ? "" : "s"}`,
            sub: h.failed.length === 0 ? `${h.total} components` : h.failed.slice(0, 2).join(", "),
            tone: h.failed.length === 0 ? "ok" : "err",
            href: "/health",
          }
        : { key: "health", label: "Health", value: "?", sub: "not checked", tone: "neutral", href: "/health" }
    );
    if (host) figures.push(diskFigure(host, now));
  } else {
    const tokenSoon = input.tokens.filter((t) => t.expiresAt !== null && t.expiresAt > now && t.expiresAt - now <= 7 * DAY).length;
    const exemptSoon = exemptions.filter((x) => x.until - now <= 7 * DAY).length;
    const n = tokenSoon + exemptSoon;
    figures.push({
      key: "expiring",
      label: "Expiring",
      value: String(n),
      sub: n > 0 ? "within 7 days" : null,
      tone: n > 0 ? "warn" : "neutral",
      href: "/account",
    });
  }

  // ── Statistics ──
  const ev = (pred: (c: string) => boolean) => events.filter((e) => pred(e.code)).map((e) => e.ts);
  const inWindow = (times: number[], from: number, to: number) => times.filter((t) => t > from && t <= to).length;
  const cur0 = now - spec.hours * HOUR;
  const prev0 = now - 2 * spec.hours * HOUR;
  const series = (times: number[]) => bucketize(times, now, spec.bucketHours * HOUR, spec.buckets);

  const created = apps.map((a) => a.createdAt);
  const depOk = ev((c) => c === "deploy_succeeded" || c === "deploy_rolled_back");
  const depBad = ev((c) => c in DEPLOY_FAIL_PHRASE);
  const rebOk = ev((c) => c === REBUILD_OK);
  const rebBad = ev((c) => REBUILD_BAD.has(c));
  const kevNew = ev((c) => KEV_NEW.has(c));

  const hitsSeriesAll = [...byId.keys()].map((id) => input.hits.get(id) ?? []);
  const sumPeriod = (skip: number) =>
    hitsSeriesAll.reduce((total, h) => total + sum(sumHourly(h, skip, spec.hours, 1)), 0);
  const hitsSeries = new Array<number>(spec.buckets).fill(0);
  for (const h of hitsSeriesAll) {
    sumHourly(h, 0, spec.bucketHours, spec.buckets).forEach((v, i) => (hitsSeries[i] = hitsSeries[i]! + v));
  }
  const hitsCur = sumPeriod(0);
  const hitsPrev = sumPeriod(spec.hours);

  const cnt = (times: number[]) => inWindow(times, cur0, now);
  const prevCnt = (times: number[]) => inWindow(times, prev0, cur0);
  const depFailCur = cnt(depBad);
  const rebFailCur = cnt(rebBad);

  const stats: Stat[] = [
    {
      key: "apps",
      label: "New apps",
      value: cnt(created),
      sub: null,
      subBad: false,
      delta: makeDelta(cnt(created), prevCnt(created), false),
      series: series(created),
    },
    {
      key: "deploys",
      label: "Deploys",
      value: cnt(depOk),
      sub: depFailCur > 0 ? `${depFailCur} failed` : null,
      subBad: depFailCur > 0,
      delta: makeDelta(cnt(depOk), prevCnt(depOk), false),
      series: series(depOk),
    },
    {
      key: "rebuilds",
      label: "Rebuilds",
      value: cnt(rebOk),
      sub: rebFailCur > 0 ? `${rebFailCur} failed` : null,
      subBad: rebFailCur > 0,
      delta: makeDelta(cnt(rebOk), prevCnt(rebOk), false),
      series: series(rebOk),
    },
    {
      key: "kev",
      label: "New KEV findings",
      value: cnt(kevNew),
      sub: null,
      subBad: false,
      delta: makeDelta(cnt(kevNew), prevCnt(kevNew), true),
      series: series(kevNew),
    },
    {
      key: "hits",
      label: "Hits",
      value: hitsCur,
      sub: null,
      subBad: false,
      delta: makeDelta(hitsCur, hitsPrev, false, { percent: true }),
      series: hitsSeries,
    },
  ];

  if (host) stats.push(...serverStats(host, spec, now));

  const topApps: TopApp[] = apps
    .map((a) => ({
      id: a.id,
      name: nameOf(a),
      hits: sum(sumHourly(input.hits.get(a.id) ?? [], 0, spec.hours, 1)),
    }))
    .filter((t) => t.hits > 0)
    .sort((a, b) => b.hits - a.hits || a.name.localeCompare(b.name))
    .slice(0, 3);

  // ── Headline ──
  const attention = nowAll.length + weekAll.length;
  const healthIssues = admin && input.health ? input.health.failed : [];
  let text: string;
  let subline: string;
  const calm = attention === 0 && healthIssues.length === 0;
  if (attention > 0) {
    text = `${plural(attention, "thing needs", "things need")} attention`;
    subline =
      nowAll.length > 0
        ? `${nowAll.length} now${weekAll.length > 0 ? `, ${weekAll.length} this week` : ""}.`
        : `${weekAll.length} this week.`;
  } else if (healthIssues.length > 0) {
    text = "Your apps are fine";
    subline = `${plural(healthIssues.length, "server component needs", "server components need")} a look: ${healthIssues.slice(0, 3).join(", ")}.`;
  } else {
    text = "Everything is fine";
    subline = "Nothing needs you right now.";
  }

  return {
    period: spec,
    headline: { calm, text, sub: subline, healthIssues },
    figures,
    inbox,
    more,
    stats,
    topApps,
    nextRebuild: input.nextRebuild,
    nowCount: nowAll.length,
  };
}

// ── Sparkline ────────────────────────────────────────────────────

/**
 * A tiny inline SVG for a series. Always finite numbers (a flat or empty
 * series is a baseline), no external anything; the title is the accessible name.
 */
export function sparkline(values: number[], title: string, w = 96, h = 24): string {
  const esc = (v: string) => v.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  const pad = 2;
  const n = values.length;
  const max = Math.max(0, ...values);
  let pts: string;
  if (n === 0) {
    pts = `${pad},${h - pad} ${w - pad},${h - pad}`;
  } else {
    const xs = (i: number) => (n === 1 ? w / 2 : pad + (i * (w - 2 * pad)) / (n - 1));
    const ys = (v: number) => (max === 0 ? h - pad : h - pad - (v / max) * (h - 2 * pad));
    pts = values.map((v, i) => `${xs(i).toFixed(1)},${ys(v).toFixed(1)}`).join(" ");
    if (n === 1) pts = `${pad},${ys(values[0]!).toFixed(1)} ${w - pad},${ys(values[0]!).toFixed(1)}`;
  }
  return `<svg class="ov-spark" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" role="img" aria-label="${esc(title)}"><title>${esc(title)}</title><polyline points="${pts}" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round" stroke-linecap="round"/></svg>`;
}
