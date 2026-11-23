/**
 * Reads what `buildOverview` needs from the database. Thin on purpose: every
 * query is scoped to the apps (or the person) the caller names, and nothing
 * here decides what is shown.
 */
import { getBucketsBulk } from "../db/activity.js";
import { listAllDevTokens, listDevTokens } from "../db/dev-tokens.js";
import { listEventCodes } from "../db/events.js";
import { getExemption } from "../db/quarantine.js";
import { getSetting } from "../db/settings.js";
import {
  bucketAverages,
  getState,
  getStateWithTime,
  latestSample,
  sampleAtOrBefore,
  windowAverage,
  type HostKind,
} from "../host/store.js";
import { listAllUserTokens, listUserTokens } from "../db/user-tokens.js";
import { formatScheduled, nextScheduledRebuild, readSchedule } from "../deploy/rebuild-scheduler.js";
import {
  HITS_HISTORY_HOURS,
  PERIOD_SPECS,
  parseTime,
  type HostInput,
  type HostSeries,
  type NextRebuild,
  type Period,
  type OverviewEvent,
  type OverviewExemption,
  type OverviewToken,
} from "./build.js";

const DAY = 86_400_000;

export interface DbInputs {
  events: OverviewEvent[];
  hits: Map<string, number[]>;
  tokens: OverviewToken[];
  exemptions: OverviewExemption[];
  nextRebuild: NextRebuild;
}

/**
 * `appIds` must already be the apps the viewer may see. Tokens are the
 * viewer's own, except for an administrator, who is told about everybody's.
 */
export function gatherDbInputs(opts: {
  appIds: string[];
  viewer: { id: string; admin: boolean };
  now: number;
}): DbInputs {
  const { appIds, viewer, now } = opts;

  const events: OverviewEvent[] = [];
  for (const r of listEventCodes(appIds, now - 60 * DAY)) {
    const ts = parseTime(r.ts);
    if (ts !== null) events.push({ appId: r.app_id, ts, code: r.code });
  }

  const hits = getBucketsBulk(appIds, HITS_HISTORY_HOURS);

  const tokens: OverviewToken[] = [];
  if (viewer.admin) {
    for (const t of listAllUserTokens()) {
      if (!t.revoked_at) tokens.push({ kind: "user", expiresAt: parseTime(t.expires_at) });
    }
    for (const t of listAllDevTokens()) tokens.push({ kind: "developer", expiresAt: parseTime(t.expires_at) });
  } else {
    for (const t of listUserTokens(viewer.id)) {
      if (!t.revoked_at) tokens.push({ kind: "user", expiresAt: parseTime(t.expires_at) });
    }
    for (const t of listDevTokens(viewer.id)) tokens.push({ kind: "developer", expiresAt: parseTime(t.expires_at) });
  }

  const exemptions: OverviewExemption[] = [];
  for (const id of appIds) {
    const e = getExemption(id);
    const until = e ? parseTime(e.until) : null;
    if (until !== null) exemptions.push({ appId: id, until });
  }

  return { events, hits, tokens, exemptions, nextRebuild: nextRebuildInfo(now) };
}

/** When the weekly "apps with issues" rebuild runs next. */
export function nextRebuildInfo(now: number): NextRebuild {
  const next = nextScheduledRebuild(readSchedule(), new Date(now), getSetting("auto_rebuild_last_date"));
  if (next.kind === "off") return { kind: "off" };
  if (next.kind === "due") return { kind: "due" };
  return { kind: "at", at: next.at, text: formatScheduled(next.at) };
}

// ── Host (administrators only: the route does not call this for anybody else) ──

const HOUR = 3_600_000;
const DATA_KINDS: HostKind[] = [
  "data_images_bytes",
  "data_containers_bytes",
  "data_volumes_bytes",
  "data_buildcache_bytes",
];

function hostSeries(kind: HostKind, now: number, period: Period): HostSeries {
  const spec = PERIOD_SPECS[period];
  const span = spec.hours * HOUR;
  const latest = latestSample(kind);
  return {
    avg: windowAverage(kind, now - span, now),
    prevAvg: windowAverage(kind, now - 2 * span, now - span),
    series: bucketAverages(kind, now, spec.bucketHours * HOUR, spec.buckets),
    measuredAt: latest ? latest.ts : null,
  };
}

function viewOf(name: "mem" | "disk"): { view: "host" | "container"; reason: string | null } {
  const view = getState(`view:${name}`) === "container" ? "container" : "host";
  const reason = getState(`reason:${name}`);
  return { view, reason: view === "container" ? reason || null : null };
}

/** What the collector stored, cut to the period. Reads only; no Docker and no /proc here. */
export function gatherHostInput(now: number, period: Period): HostInput {
  const spec = PERIOD_SPECS[period];
  const span = spec.hours * HOUR;

  const diskRow = getStateWithTime("disk_last");
  let disk: HostInput["disk"] = null;
  if (diskRow) {
    try {
      const d = JSON.parse(diskRow.value) as { total: number; used: number; free: number; pct: number };
      if ([d.total, d.used, d.free, d.pct].every((x) => typeof x === "number" && Number.isFinite(x))) {
        disk = { totalBytes: d.total, usedBytes: d.used, freeBytes: d.free, pct: d.pct, measuredAt: diskRow.updatedAt };
      }
    } catch {
      /* a damaged row reads as "no data yet" */
    }
  }

  const latestData = DATA_KINDS.map((k) => latestSample(k));
  let data: HostInput["data"] = null;
  if (latestData.every((x) => x !== null)) {
    const [images, containers, volumes, buildcache] = latestData.map((x) => x!.value) as [number, number, number, number];
    const startParts = DATA_KINDS.map((k) => sampleAtOrBefore(k, now - span));
    const perKind = DATA_KINDS.map((k) => bucketAverages(k, now, spec.bucketHours * HOUR, spec.buckets));
    const series = Array.from({ length: spec.buckets }, (_, i) => {
      const vals = perKind.map((s) => s[i] ?? null);
      return vals.every((v) => v === null) ? null : vals.reduce<number>((a, v) => a + (v ?? 0), 0);
    });
    data = {
      totalBytes: images + containers + volumes + buildcache,
      startBytes: startParts.every((x) => x !== null) ? startParts.reduce((a, x) => a + x!.value, 0) : null,
      series,
      parts: { images, volumes, containers, buildcache },
      note: getState("data_note") || null,
      measuredAt: Math.max(...latestData.map((x) => x!.ts)),
    };
  }

  const memTotal = Number(getState("mem_total_bytes"));
  const errors: HostInput["errors"] = {};
  for (const name of ["disk", "cpu", "mem", "data"] as const) {
    const e = getState(`err:${name}`);
    if (e) errors[name] = e;
  }
  return {
    procView: viewOf("mem"),
    diskView: viewOf("disk"),
    disk,
    cpu: hostSeries("cpu_pct", now, period),
    mem: hostSeries("mem_used_bytes", now, period),
    memTotalBytes: Number.isFinite(memTotal) && memTotal > 0 ? memTotal : null,
    data,
    errors,
  };
}
