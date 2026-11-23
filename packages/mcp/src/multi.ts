/**
 * What the tools that look across servers hand to the model: which Runways
 * there are and whether they answer, the apps on each, and events with one
 * cursor per server.
 *
 * Every answer is rebuilt field by field, like the events in events.ts: a
 * server's words reach the model only through a pattern, a length cap and
 * cleanText. The `runway` field on a result is written HERE from the name in
 * the local config, never read from what a server sent, so one server cannot
 * pass its text off as another's, and a server's own `runway` field (or any
 * other extra field) is dropped.
 *
 * One server failing never fails the rest: each server's result stands alone,
 * with its own error text.
 */

import { RunwayApiError, RunwayUsageError } from "./errors.js";
import { cleanText, type EventItem, type EventsPage } from "./events.js";
import type { RunwayRegistry } from "./registry.js";
import type { ServerConfig } from "./config.js";

/** How many servers are asked at the same time. */
export const SERVER_CONCURRENCY = 4;
/** A probe or a list must be quick; a server that is not answers "unreachable", not "wait". */
export const LIST_TIMEOUT_MS = 10_000;
const LOOK = { timeoutMs: LIST_TIMEOUT_MS } as const;
const MAX_ERROR_CHARS = 300;
const MAX_APPS_PER_SERVER = 500;

export async function mapLimit<T, R>(items: readonly T[], limit: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const worker = async () => {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      out[i] = await fn(items[i]!, i);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

/** The text of a failure, safe to show: no credential, no control characters, short. */
export function failureText(err: unknown, server?: ServerConfig): string {
  let text: string;
  if (err instanceof RunwayApiError || err instanceof RunwayUsageError) text = err.message;
  else text = "Unexpected error while talking to this server.";
  if (server) {
    for (const s of [server.token, server.legacyKey, ...Object.values(server.appKeys)]) {
      if (s && s.length >= 6) text = text.split(s).join("[redacted]");
    }
  }
  return cleanText(text, MAX_ERROR_CHARS).text;
}

// ── small shape checkers ──────────────────────────────────────────────────

const WORD_RE = /^[a-z][a-z0-9_ -]{0,29}$/i;
const APP_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const HOST_RE = /^[A-Za-z0-9.-]{1,253}$/;

function word(v: unknown): string | null {
  return typeof v === "string" && WORD_RE.test(v) ? v : null;
}
function isoOrNull(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const t = Date.parse(v);
  return Number.isFinite(t) ? new Date(t).toISOString() : null;
}
function obj(v: unknown): Record<string, unknown> {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

// ── GET /me ────────────────────────────────────────────────────────────────

export interface MeOut {
  username: string;
  role: string;
  scope: string;
  expires_at: string | null;
}

export function cleanMe(raw: unknown): MeOut | null {
  const top = obj(raw);
  const user = obj(top.user);
  const token = obj(top.token);
  const username = typeof user.username === "string" ? cleanText(user.username, 64).text : "";
  const role = word(user.role);
  const scope = word(token.scope);
  if (!username || !role || !scope) return null;
  return { username, role, scope, expires_at: isoOrNull(token.expires_at) };
}

// ── list_runways ───────────────────────────────────────────────────────────

export interface RunwayStatus {
  name: string;
  url: string;
  mode: "user-token" | "app-keys" | "app-key (legacy)";
  reachable?: boolean;
  credential?: "valid" | "invalid or expired" | "not checked";
  user?: string;
  role?: string;
  scope?: string;
  expires_at?: string | null;
  expires_in_days?: number;
  expires_soon?: boolean;
  app?: { id: string; name: string | null };
  apps_with_keys?: number;
  error?: string;
}

const EXPIRES_SOON_DAYS = 14;

async function probe(registry: RunwayRegistry, server: ServerConfig, now: number): Promise<RunwayStatus> {
  const base = { name: server.name, url: server.url };

  if (server.legacyKey) {
    const status: RunwayStatus = { ...base, mode: "app-key (legacy)" };
    try {
      const { client } = registry.clientFor(server.name, undefined, LOOK);
      const cfg = obj(await client.getConfig());
      status.reachable = true;
      status.credential = "valid";
      if (typeof cfg.id === "string" && APP_ID_RE.test(cfg.id)) {
        status.app = { id: cfg.id, name: typeof cfg.name === "string" ? cleanText(cfg.name, 64).text : null };
      }
    } catch (err) {
      applyProbeFailure(status, err, server);
    }
    return status;
  }

  if (server.token) {
    const status: RunwayStatus = { ...base, mode: "user-token" };
    try {
      const { client } = registry.clientFor(server.name, undefined, { account: true, ...LOOK });
      const me = cleanMe(await client.getMe());
      status.reachable = true;
      if (!me) {
        status.credential = "not checked";
        status.error = "The server answered, but not in the shape of a Runway that supports user tokens. Is it up to date?";
        return status;
      }
      status.credential = "valid";
      status.user = me.username;
      status.role = me.role;
      status.scope = me.scope;
      status.expires_at = me.expires_at;
      if (me.expires_at) {
        const days = Math.floor((Date.parse(me.expires_at) - now) / 86_400_000);
        status.expires_in_days = days;
        status.expires_soon = days <= EXPIRES_SOON_DAYS;
      }
    } catch (err) {
      applyProbeFailure(status, err, server);
    }
    return status;
  }

  // Only per-app keys: there is no call that checks a key without touching an app, so say so.
  return {
    ...base,
    mode: "app-keys",
    credential: "not checked",
    apps_with_keys: Object.keys(server.appKeys).length,
  };
}

function applyProbeFailure(status: RunwayStatus, err: unknown, server: ServerConfig): void {
  if (err instanceof RunwayApiError) {
    if (err.status === 0) {
      status.reachable = false;
      status.error = failureText(err, server);
      return;
    }
    status.reachable = true;
    if (err.status === 401) {
      status.credential = "invalid or expired";
      return;
    }
  }
  status.error = failureText(err, server);
}

export async function listRunways(registry: RunwayRegistry, now = Date.now()): Promise<{ runways: RunwayStatus[]; warnings: string[] }> {
  const runways = await mapLimit(registry.servers, SERVER_CONCURRENCY, (s) => probe(registry, s, now));
  return { runways, warnings: [...registry.warnings] };
}

// ── list_apps ──────────────────────────────────────────────────────────────

export interface AppSummary {
  id: string;
  name: string | null;
  runtime: string | null;
  status: string | null;
  domain: string | null;
  configured: boolean;
  can_rebuild?: boolean;
  can_rescan?: boolean;
}

export function cleanApp(raw: unknown): AppSummary | null {
  const a = obj(raw);
  if (typeof a.id !== "string" || !APP_ID_RE.test(a.id)) return null;
  const can = obj(a.can);
  const out: AppSummary = {
    id: a.id,
    name: typeof a.name === "string" && a.name ? cleanText(a.name, 64).text : null,
    runtime: word(a.runtime),
    status: word(a.status),
    domain: typeof a.domain === "string" && HOST_RE.test(a.domain) ? a.domain : null,
    configured: a.configured === true,
  };
  if (typeof can.rebuild === "boolean") out.can_rebuild = can.rebuild;
  if (typeof can.rescan === "boolean") out.can_rescan = can.rescan;
  return out;
}

export interface AppsResult {
  runway: string;
  ok: boolean;
  apps?: AppSummary[];
  truncated?: true;
  error?: string;
}

async function appsOf(registry: RunwayRegistry, server: ServerConfig): Promise<AppsResult> {
  try {
    // A user token lists every app it may see.
    if (server.token && !server.legacyKey) {
      const { client } = registry.clientFor(server.name, undefined, { account: true, ...LOOK });
      const raw = obj(await client.listApps());
      const list = Array.isArray(raw.apps) ? raw.apps : [];
      const apps = list.slice(0, MAX_APPS_PER_SERVER).map(cleanApp).filter((a): a is AppSummary => a !== null);
      const res: AppsResult = { runway: server.name, ok: true, apps };
      if (list.length > MAX_APPS_PER_SERVER) res.truncated = true;
      return res;
    }
    // App keys (and the legacy single key): each key is one app, ask it.
    const ids = server.legacyKey ? [undefined] : Object.keys(server.appKeys);
    const results = await mapLimit(ids, SERVER_CONCURRENCY, async (id) => {
      try {
        const { client } = registry.clientFor(server.name, id, LOOK);
        return cleanApp(await client.getConfig());
      } catch (err) {
        return { error: failureText(err, server) };
      }
    });
    const apps = results.filter((r): r is AppSummary => r !== null && !("error" in (r as object)));
    const errors = results.filter((r): r is { error: string } => !!r && "error" in (r as object));
    if (apps.length === 0 && errors.length > 0) return { runway: server.name, ok: false, error: errors[0]!.error };
    return { runway: server.name, ok: true, apps };
  } catch (err) {
    return { runway: server.name, ok: false, error: failureText(err, server) };
  }
}

export async function listApps(registry: RunwayRegistry, runway?: string): Promise<{ runways: AppsResult[] }> {
  const servers = registry.select(runway);
  return { runways: await mapLimit(servers, SERVER_CONCURRENCY, (s) => appsOf(registry, s)) };
}

// ── events across servers ──────────────────────────────────────────────────

const CURSOR_RE = /^c1_[0-9a-z]{1,12}$/;

export type SinceInput = string | Record<string, string> | undefined;

export interface ServerEventsState {
  ok: boolean;
  has_more?: boolean;
  initial?: true;
  cursor_expired?: true;
  note?: string;
  error?: string;
}

export interface MultiEventsOut {
  /** Oldest first by time; each carries the server it came from. */
  events: Array<EventItem & { runway: string }>;
  /** The cursor to pass back, per server. A server that failed keeps the cursor it was given. */
  next: Record<string, string>;
  servers: Record<string, ServerEventsState>;
  usage: string;
}

export const MULTI_EVENTS_USAGE =
  "Keep `next` (a map of Runway name to cursor) and pass it back as `since`; nothing is remembered between calls. " +
  "Cursors are per server and mean nothing on another one. A server missing from `since` gives its latest events. " +
  "Each event carries its `runway`; for details call runway_event_detail with that `runway` and the event `id`.";

/** The cursor each selected server starts from, checked against the names we know. */
export function cursorsFor(since: SinceInput, servers: readonly ServerConfig[]): Map<string, string | undefined> {
  const out = new Map<string, string | undefined>();
  if (since === undefined) return out;
  if (typeof since === "string") {
    if (servers.length !== 1) {
      throw new RunwayUsageError(
        "`since` as a single cursor only works when one Runway is asked. Pass a map of Runway name to cursor, e.g. the `next` of the previous answer."
      );
    }
    if (!CURSOR_RE.test(since)) throw new RunwayUsageError("`since` is not a cursor from runway_events.");
    out.set(servers[0]!.name, since);
    return out;
  }
  const known = new Set(servers.map((s) => s.name));
  for (const [name, cursor] of Object.entries(since)) {
    if (!known.has(name)) {
      throw new RunwayUsageError(`\`since\` names a Runway that is not asked: '${name.slice(0, 40)}'. Asked: ${[...known].join(", ")}.`);
    }
    if (!CURSOR_RE.test(cursor)) throw new RunwayUsageError(`The cursor for '${name}' is not a cursor from runway_events.`);
    out.set(name, cursor);
  }
  return out;
}

export async function collectEvents(
  registry: RunwayRegistry,
  input: { since?: SinceInput; runway?: string; limit?: number; app?: string }
): Promise<MultiEventsOut> {
  const servers = registry.select(input.runway);
  const cursors = cursorsFor(input.since, servers);

  const pages = await mapLimit(servers, SERVER_CONCURRENCY, async (server) => {
    try {
      const { client } = registry.clientFor(server.name, input.app, { account: true, ...LOOK });
      const page: EventsPage = await client.getEvents(cursors.get(server.name), input.limit, input.app);
      return { server, page };
    } catch (err) {
      return { server, error: failureText(err, server) };
    }
  });

  const events: Array<EventItem & { runway: string }> = [];
  const next: Record<string, string> = {};
  const state: Record<string, ServerEventsState> = {};
  const order = new Map(servers.map((s, i) => [s.name, i]));

  for (const r of pages) {
    const name = r.server.name;
    const given = cursors.get(name);
    if ("error" in r && r.error !== undefined) {
      state[name] = { ok: false, error: r.error };
      if (given) next[name] = given;
      continue;
    }
    const page = (r as { page: EventsPage }).page;
    for (const e of page.events) events.push({ ...e, runway: name });
    const s: ServerEventsState = { ok: true, has_more: page.has_more };
    if (page.initial) s.initial = true;
    if (page.cursor_expired) {
      s.cursor_expired = true;
      if (page.note) s.note = page.note;
    }
    state[name] = s;
    next[name] = page.next_cursor || given || "";
    if (!next[name]) delete next[name];
  }

  // Oldest first across servers. Within one server the order it gave is kept.
  const indexed = events.map((e, i) => ({ e, i }));
  indexed.sort((a, b) => {
    const t = Date.parse(a.e.ts) - Date.parse(b.e.ts);
    if (t !== 0) return t;
    const o = (order.get(a.e.runway) ?? 0) - (order.get(b.e.runway) ?? 0);
    return o !== 0 ? o : a.i - b.i;
  });

  return { events: indexed.map((x) => x.e), next, servers: state, usage: MULTI_EVENTS_USAGE };
}

export function renderMultiEvents(out: MultiEventsOut): string {
  return JSON.stringify(out, null, 2);
}
