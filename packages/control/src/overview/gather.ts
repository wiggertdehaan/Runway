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
import { listAllUserTokens, listUserTokens } from "../db/user-tokens.js";
import { formatScheduled, nextScheduledRebuild, readSchedule } from "../deploy/rebuild-scheduler.js";
import {
  HITS_HISTORY_HOURS,
  parseTime,
  type NextRebuild,
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
