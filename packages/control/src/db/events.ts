import { db } from "./index.js";
import {
  buildEventView,
  cleanFacts,
  codeInfo,
  decodeCursor,
  isEventCode,
  sanitizeUntrusted,
  type EmitInput,
  type EventRow,
  type EventView,
} from "../util/events.js";

/**
 * The event log (see util/events.ts for what an event is and what it never
 * carries). One table for every app, read through a cursor.
 *
 * Why a table of its own and not `app_notices`: a notice is a sentence for the
 * owner's page, written by whoever raised it and shown as text, with no code
 * and no severity. An event is a fixed code plus a few validated fields. The
 * notices stay as they are; events are written next to them.
 */

/** Longest the log keeps an event, and the most it keeps per app. */
export function eventRetentionDays(): number {
  const n = Number(process.env.EVENTS_RETENTION_DAYS);
  return Number.isFinite(n) && n >= 1 && n <= 3650 ? Math.floor(n) : 60;
}
export function eventMaxPerApp(): number {
  const n = Number(process.env.EVENTS_MAX_PER_APP);
  return Number.isFinite(n) && n >= 10 && n <= 100000 ? Math.floor(n) : 500;
}

/**
 * Write an event. Never throws: an event is a courtesy to a reader and must not
 * be able to break a deploy, a rebuild or the quarantine tick. Returns the new
 * id, or null when nothing was written (a repeat inside its dedupe window, an
 * app that is gone, a database error).
 */
export function emitEvent(input: EmitInput, now: number = Date.now()): number | null {
  try {
    if (!isEventCode(input.code)) return null;
    const info = codeInfo(input.code);
    const ts = new Date(now).toISOString();

    if (input.dedupeKey) {
      const since = new Date(now - (input.dedupeDays ?? 1) * 86_400_000).toISOString();
      const dup = db
        .prepare(`SELECT 1 FROM app_events WHERE app_id = ? AND dedupe_key = ? AND ts >= ? LIMIT 1`)
        .get(input.appId, input.dedupeKey, since);
      if (dup) return null;
    }

    const facts = cleanFacts(input.facts);
    const untrusted = input.untrusted ? sanitizeUntrusted(input.untrusted) : null;
    const detail =
      Object.keys(facts).length > 0 || untrusted?.text
        ? JSON.stringify({
            facts,
            ...(untrusted?.text ? { untrusted: { text: untrusted.text, truncated: untrusted.truncated } } : {}),
          })
        : null;

    const res = db
      .prepare(
        `INSERT INTO app_events (app_id, ts, type, code, severity, detail, dedupe_key)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      )
      .run(input.appId, ts, info.type, input.code, info.severity, detail, input.dedupeKey ?? null);
    return Number(res.lastInsertRowid);
  } catch (err) {
    console.error("event write failed:", (err as Error).message);
    return null;
  }
}

// ── Reading ──────────────────────────────────────────────────────

/** Which apps a caller may read events of. */
export type EventAudience = { all: true } | { all: false; appIds: string[] };

function audienceClause(a: EventAudience): { sql: string; params: string[] } {
  if (a.all) return { sql: "", params: [] };
  // json_each takes the list as one parameter, so a long list is not a problem.
  return { sql: ` AND app_id IN (SELECT value FROM json_each(?))`, params: [JSON.stringify(a.appIds)] };
}

/** The highest id the log has ever issued (it never goes back, even after pruning). */
export function eventHeadId(): number {
  const r = db.prepare(`SELECT seq FROM sqlite_sequence WHERE name = 'app_events'`).get() as
    | { seq: number }
    | undefined;
  return r ? Number(r.seq) : 0;
}

/** Events with an id at or below this have been pruned. */
export function eventFloorId(): number {
  const r = db.prepare(`SELECT value FROM event_meta WHERE key = 'floor'`).get() as
    | { value: string }
    | undefined;
  const n = r ? Number(r.value) : 0;
  return Number.isFinite(n) ? n : 0;
}

export interface EventPage {
  events: EventView[];
  hasMore: boolean;
  /** The caller's cursor was older than what is kept, or not one we issued. */
  cursorExpired: boolean;
  /** Continue from here. Equal to `since` when nothing new was visible. */
  nextCursor: number;
}

export interface ListOptions {
  /** Decoded cursor; null for a first call (the latest events, ascending). */
  since: number | null;
  limit: number;
  audience: EventAudience;
  /** How many to return on a first call. */
  initial?: number;
}

/**
 * One page, oldest first. Only what `audience` may see. When `since` is older
 * than the floor (events were pruned that it may not have seen) or newer than
 * anything issued (a restored backup), `cursorExpired` is set and the page
 * starts from the oldest event still kept, so the caller learns what remains and
 * that it missed something, not silence.
 */
export function listEvents(opts: ListOptions): EventPage {
  const aud = audienceClause(opts.audience);
  const limit = Math.max(1, Math.min(opts.limit, 200));

  if (opts.since === null) {
    const n = Math.max(1, Math.min(opts.initial ?? 20, limit));
    const rows = (
      db
        .prepare(
          `SELECT * FROM (SELECT * FROM app_events WHERE 1=1${aud.sql} ORDER BY id DESC LIMIT ?) ORDER BY id ASC`
        )
        .all(...aud.params, n) as unknown as EventRow[]
    );
    const events = rows.map(buildEventView).filter((e): e is EventView => e !== null);
    const last = rows.length > 0 ? rows[rows.length - 1]!.id : 0;
    return { events, hasMore: false, cursorExpired: false, nextCursor: last };
  }

  const floor = eventFloorId();
  const head = eventHeadId();
  let since = opts.since;
  let expired = false;
  if (since < floor || since > head) {
    expired = true;
    since = floor;
  }

  const rows = db
    .prepare(`SELECT * FROM app_events WHERE id > ?${aud.sql} ORDER BY id ASC LIMIT ?`)
    .all(since, ...aud.params, limit + 1) as unknown as EventRow[];
  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;
  const events = page.map(buildEventView).filter((e): e is EventView => e !== null);
  const nextCursor = page.length > 0 ? page[page.length - 1]!.id : since;
  return { events, hasMore, cursorExpired: expired, nextCursor };
}

/**
 * Just (app, time, code) of every event since `sinceMs` for the given apps,
 * oldest first. The overview counts and orders these; it never needs the
 * detail, so no detail is read.
 */
export function listEventCodes(
  appIds: string[],
  sinceMs: number
): Array<{ app_id: string; ts: string; code: string }> {
  if (appIds.length === 0) return [];
  return db
    .prepare(
      `SELECT app_id, ts, code FROM app_events
       WHERE ts >= ? AND app_id IN (SELECT value FROM json_each(?))
       ORDER BY id ASC`
    )
    .all(new Date(sinceMs).toISOString(), JSON.stringify(appIds)) as Array<{
    app_id: string;
    ts: string;
    code: string;
  }>;
}

export function getEventRow(id: number): EventRow | undefined {
  return db.prepare(`SELECT * FROM app_events WHERE id = ?`).get(id) as unknown as
    | EventRow
    | undefined;
}

export function getEventRowByCursor(cursor: string): EventRow | undefined {
  const id = decodeCursor(cursor);
  return id === null ? undefined : getEventRow(id);
}

// ── Retention ────────────────────────────────────────────────────

/**
 * Drop events older than the retention window, then the oldest beyond the
 * per-app maximum, and remember the highest id dropped as the floor, so a cursor
 * from before it is reported as expired instead of quietly skipping events.
 * Returns how many were removed.
 */
export function pruneEvents(now: number = Date.now()): number {
  const cutoff = new Date(now - eventRetentionDays() * 86_400_000).toISOString();
  let removed = 0;
  let maxDropped = 0;
  try {
    const old = db
      .prepare(`SELECT MAX(id) AS m, COUNT(*) AS n FROM app_events WHERE ts < ?`)
      .get(cutoff) as { m: number | null; n: number };
    if (old.n > 0) {
      db.prepare(`DELETE FROM app_events WHERE ts < ?`).run(cutoff);
      removed += old.n;
      maxDropped = Math.max(maxDropped, Number(old.m ?? 0));
    }

    const max = eventMaxPerApp();
    const over = db
      .prepare(`SELECT app_id FROM app_events GROUP BY app_id HAVING COUNT(*) > ?`)
      .all(max) as Array<{ app_id: string }>;
    for (const { app_id } of over) {
      const cut = db
        .prepare(`SELECT id FROM app_events WHERE app_id = ? ORDER BY id DESC LIMIT 1 OFFSET ?`)
        .get(app_id, max - 1) as { id: number } | undefined;
      if (!cut) continue;
      const dropped = db
        .prepare(`SELECT MAX(id) AS m, COUNT(*) AS n FROM app_events WHERE app_id = ? AND id < ?`)
        .get(app_id, cut.id) as { m: number | null; n: number };
      if (dropped.n > 0) {
        db.prepare(`DELETE FROM app_events WHERE app_id = ? AND id < ?`).run(app_id, cut.id);
        removed += dropped.n;
        maxDropped = Math.max(maxDropped, Number(dropped.m ?? 0));
      }
    }

    if (maxDropped > eventFloorId()) {
      db.prepare(
        `INSERT INTO event_meta (key, value) VALUES ('floor', ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value`
      ).run(String(maxDropped));
    }
  } catch (err) {
    console.error("event prune failed:", (err as Error).message);
  }
  return removed;
}
