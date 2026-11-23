import { getSetting, setSetting } from "../db/settings.js";
import { closeOrphanedRebuildRuns } from "../db/rebuild-runs.js";
import { RebuildBusyError, startRebuildRun } from "./rebuild.js";

/**
 * Weekly automatic rebuild of apps with an actively exploited (KEV) or
 * critical-with-fix vulnerability. Defaults to Sunday 05:00
 * Europe/Amsterdam; day, time and on/off are admin settings.
 *
 * A one-minute tick compares the current Amsterdam wall-clock time
 * against the schedule, so DST shifts need no special handling. The
 * date of the last launch is persisted, so a restart inside the same
 * minute window can't double-fire and a missed slot (control down at
 * 05:00) still runs when it comes back up later that day.
 */

export const SCHEDULE_TZ = "Europe/Amsterdam";
export const DEFAULT_DAY = 0; // Sunday
export const DEFAULT_TIME = "05:00";
const TICK_MS = 60 * 1000;

type Logger = Pick<Console, "log" | "warn" | "error">;

export interface LocalParts {
  /** YYYY-MM-DD in the schedule timezone. */
  date: string;
  /** 0 = Sunday … 6 = Saturday. */
  weekday: number;
  /** Minutes since local midnight. */
  minutes: number;
}

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

/** Pure: wall-clock parts of `now` in `tz`. */
export function localParts(now: Date, tz: string = SCHEDULE_TZ): LocalParts {
  const fmt = new Intl.DateTimeFormat("en-GB", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  });
  const p: Record<string, string> = {};
  for (const part of fmt.formatToParts(now)) p[part.type] = part.value;
  return {
    date: `${p.year}-${p.month}-${p.day}`,
    weekday: WEEKDAYS.indexOf(p.weekday),
    minutes: parseInt(p.hour, 10) * 60 + parseInt(p.minute, 10),
  };
}

/** Pure: "HH:MM" -> minutes since midnight, or null if invalid. */
export function parseTime(value: string | undefined): number | null {
  const m = /^([01]?\d|2[0-3]):([0-5]\d)$/.exec((value ?? "").trim());
  return m ? parseInt(m[1], 10) * 60 + parseInt(m[2], 10) : null;
}

export function normalizeTime(value: string | undefined): string | null {
  const mins = parseTime(value);
  if (mins === null) return null;
  return `${String(Math.floor(mins / 60)).padStart(2, "0")}:${String(mins % 60).padStart(2, "0")}`;
}

export interface Schedule {
  enabled: boolean;
  day: number;
  time: string;
}

/** Read the schedule, falling back to defaults for unset/garbage values. */
export function readSchedule(): Schedule {
  const day = parseInt(getSetting("auto_rebuild_day") ?? "", 10);
  return {
    enabled: (getSetting("auto_rebuild_enabled") ?? "1") !== "0",
    day: Number.isInteger(day) && day >= 0 && day <= 6 ? day : DEFAULT_DAY,
    time: normalizeTime(getSetting("auto_rebuild_time")) ?? DEFAULT_TIME,
  };
}

export function saveSchedule(s: Schedule): void {
  setSetting("auto_rebuild_enabled", s.enabled ? "1" : "0");
  setSetting("auto_rebuild_day", String(s.day));
  setSetting("auto_rebuild_time", s.time);
}

/**
 * Pure: is a scheduled run due right now? Due when it is the right
 * weekday, the time has been reached, and we haven't launched today.
 */
export function isRebuildDue(
  schedule: Schedule,
  now: LocalParts,
  lastRunDate: string | undefined
): boolean {
  if (!schedule.enabled) return false;
  if (now.weekday !== schedule.day) return false;
  const at = parseTime(schedule.time) ?? parseTime(DEFAULT_TIME)!;
  if (now.minutes < at) return false;
  return lastRunDate !== now.date;
}

/** Offset (ms) of `tz` from UTC at the instant `utcMs`. */
function tzOffsetMs(utcMs: number, tz: string): number {
  const fmt = new Intl.DateTimeFormat("en-GB", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  });
  const p: Record<string, string> = {};
  for (const part of fmt.formatToParts(new Date(utcMs))) p[part.type] = part.value;
  const asUtc = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second);
  return asUtc - Math.floor(utcMs / 1000) * 1000;
}

/** Pure: the UTC instant at which `tz` shows `date` (YYYY-MM-DD) at `minutes` past midnight. */
export function zonedToUtc(date: string, minutes: number, tz: string = SCHEDULE_TZ): number {
  const [y, m, d] = date.split("-").map(Number);
  const guess = Date.UTC(y!, m! - 1, d!, 0, minutes);
  const first = guess - tzOffsetMs(guess, tz);
  return guess - tzOffsetMs(first, tz);
}

export type NextScheduled =
  | { kind: "off" }
  | { kind: "due" }
  | { kind: "at"; at: number };

/**
 * Pure: when the weekly run fires next. "due" = it would launch at the next
 * tick (right day, time passed, not launched today yet), "off" = switched off.
 * Counts calendar days in the schedule's own timezone, so a DST change
 * cannot skip or repeat a weekday.
 */
export function nextScheduledRebuild(
  schedule: Schedule,
  now: Date,
  lastRunDate: string | undefined,
  tz: string = SCHEDULE_TZ
): NextScheduled {
  if (!schedule.enabled) return { kind: "off" };
  const parts = localParts(now, tz);
  const at = parseTime(schedule.time) ?? parseTime(DEFAULT_TIME)!;
  if (isRebuildDue(schedule, parts, lastRunDate)) return { kind: "due" };
  const [y, m, d] = parts.date.split("-").map(Number);
  for (let i = 0; i <= 8; i++) {
    const day = new Date(Date.UTC(y!, m! - 1, d! + i));
    if (day.getUTCDay() !== schedule.day) continue;
    const date = day.toISOString().slice(0, 10);
    const utc = zonedToUtc(date, at, tz);
    if (utc > now.getTime()) return { kind: "at", at: utc };
  }
  return { kind: "off" };
}

/** "Sun 29 Nov 05:00" in the schedule's timezone. */
export function formatScheduled(ms: number, tz: string = SCHEDULE_TZ): string {
  const fmt = new Intl.DateTimeFormat("en-GB", {
    timeZone: tz,
    weekday: "short",
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  });
  const p: Record<string, string> = {};
  for (const part of fmt.formatToParts(new Date(ms))) p[part.type] = part.value;
  return `${p.weekday} ${p.day} ${p.month} ${p.hour}:${p.minute}`;
}

export function startRebuildScheduler(log: Logger = console): () => void {
  const closed = closeOrphanedRebuildRuns();
  if (closed > 0) log.warn(`[rebuild] closed ${closed} run(s) interrupted by a restart`);

  const tick = () => {
    try {
      const schedule = readSchedule();
      const now = localParts(new Date());
      if (!isRebuildDue(schedule, now, getSetting("auto_rebuild_last_date"))) return;
      // Record the launch first: even if the run crashes we don't want
      // to retry every minute for the rest of the day.
      setSetting("auto_rebuild_last_date", now.date);
      log.log("[rebuild] scheduled run starting");
      startRebuildRun({ trigger: "scheduled", onlyVulnerable: true, log });
    } catch (err) {
      if (err instanceof RebuildBusyError) {
        log.warn("[rebuild] scheduled run skipped: another run is in progress");
      } else {
        log.error(`[rebuild] scheduler tick failed: ${(err as Error).message}`);
      }
    }
  };

  log.log(
    `[rebuild] scheduler started (default ${WEEKDAYS[DEFAULT_DAY]} ${DEFAULT_TIME} ${SCHEDULE_TZ}, configurable)`
  );
  const handle = setInterval(tick, TICK_MS);
  handle.unref?.();
  return () => clearInterval(handle);
}
