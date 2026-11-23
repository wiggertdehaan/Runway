/**
 * S21: rate limits per token, not only per IP.
 *
 * A fixed-window counter keyed by an actor string (`api-key:<app id>`, and later
 * `user-token:<id>` or `mcp-token:<id>`), so one noisy key cannot use up the
 * allowance of another, and many people behind one office address do not share
 * one allowance. Pure and in memory: no database, no clock of its own (callers
 * may pass `now`), so it is easy to test.
 *
 * In memory is deliberate. Runway runs as one control process; a restart resets
 * the counters, which at worst gives a caller one extra window. The heavy
 * actions (deploy, rebuild) keep their own concurrency guards, which are
 * unchanged. If control is ever run as several processes, move this to the
 * database before relying on it.
 */

export type Bucket = "read" | "write" | "heavy";

export interface Window {
  /** Requests allowed per window. */
  limit: number;
  windowMs: number;
}

export interface LimitConfig {
  read: Window;
  write: Window;
  heavy: Window;
  /** Failed key guesses from one source address. */
  authFail: Window;
}

export interface HitResult {
  allowed: boolean;
  limit: number;
  remaining: number;
  /** Whole seconds until the window ends; at least 1 when refused. */
  retryAfterSec: number;
}

const MINUTE = 60 * 1000;

export const DEFAULT_LIMITS: LimitConfig = {
  read: { limit: 120, windowMs: MINUTE },
  write: { limit: 60, windowMs: MINUTE },
  // Deploy, rollback and source download. A deploy builds an image, so this is
  // deliberately tight: ten in ten minutes is a busy afternoon for one app.
  heavy: { limit: 10, windowMs: 10 * MINUTE },
  // Wrong keys from one address. Only a key that does not exist counts, not a
  // missing header, so a monitor without credentials cannot lock itself out.
  authFail: { limit: 20, windowMs: 10 * MINUTE },
};

/** Largest allowance an operator may configure, so a typo cannot disable the limit. */
const MAX_LIMIT = 100_000;

/** A positive whole number from the environment, or the default. */
export function parseLimit(raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw.trim() === "") return fallback;
  if (!/^\d+$/.test(raw.trim())) return fallback;
  const n = Number(raw.trim());
  if (!Number.isSafeInteger(n) || n < 1) return fallback;
  return Math.min(n, MAX_LIMIT);
}

export function limitsFromEnv(env: Record<string, string | undefined>): LimitConfig {
  return {
    read: {
      limit: parseLimit(env.RATE_LIMIT_READ_PER_MIN, DEFAULT_LIMITS.read.limit),
      windowMs: DEFAULT_LIMITS.read.windowMs,
    },
    write: {
      limit: parseLimit(env.RATE_LIMIT_WRITE_PER_MIN, DEFAULT_LIMITS.write.limit),
      windowMs: DEFAULT_LIMITS.write.windowMs,
    },
    heavy: {
      limit: parseLimit(env.RATE_LIMIT_HEAVY_PER_10MIN, DEFAULT_LIMITS.heavy.limit),
      windowMs: DEFAULT_LIMITS.heavy.windowMs,
    },
    authFail: {
      limit: parseLimit(env.RATE_LIMIT_AUTH_FAIL_PER_10MIN, DEFAULT_LIMITS.authFail.limit),
      windowMs: DEFAULT_LIMITS.authFail.windowMs,
    },
  };
}

/**
 * Routes that cost real work. Everything else is `read` (GET/HEAD) or `write`.
 * Keyed "METHOD /full/path"; a test checks every entry is still a real route.
 */
export const HEAVY_ROUTES: ReadonlySet<string> = new Set([
  "POST /api/v1/app/deploy", // builds an image
  "POST /api/v1/app/rollback", // starts a container
  "GET /api/v1/app/source", // streams the whole source archive
]);

export function classifyRequest(method: string, path: string): Bucket {
  const m = method.toUpperCase();
  const p = path.length > 1 ? path.replace(/\/+$/, "") : path;
  if (HEAVY_ROUTES.has(`${m} ${p}`)) return "heavy";
  if (m === "GET" || m === "HEAD" || m === "OPTIONS") return "read";
  return "write";
}

interface Entry {
  count: number;
  resetAt: number;
}

export class FixedWindowCounter {
  private entries = new Map<string, Entry>();

  /**
   * @param maxKeys upper bound on tracked keys. When it is reached, expired
   *   entries go first and then the oldest, so memory cannot grow without limit
   *   however many sources or tokens show up.
   */
  constructor(private readonly maxKeys = 20_000) {}

  get size(): number {
    return this.entries.size;
  }

  /** Count one request against `key`. */
  hit(key: string, win: Window, now = Date.now()): HitResult {
    let e = this.entries.get(key);
    if (!e || e.resetAt <= now) {
      this.makeRoom(now);
      e = { count: 0, resetAt: now + win.windowMs };
      this.entries.set(key, e);
    }
    if (e.count >= win.limit) {
      return {
        allowed: false,
        limit: win.limit,
        remaining: 0,
        retryAfterSec: Math.max(1, Math.ceil((e.resetAt - now) / 1000)),
      };
    }
    e.count += 1;
    return {
      allowed: true,
      limit: win.limit,
      remaining: win.limit - e.count,
      retryAfterSec: 0,
    };
  }

  /** Count one event without ever refusing it (used for failed guesses). */
  record(key: string, win: Window, now = Date.now()): void {
    let e = this.entries.get(key);
    if (!e || e.resetAt <= now) {
      this.makeRoom(now);
      e = { count: 0, resetAt: now + win.windowMs };
      this.entries.set(key, e);
    }
    e.count += 1;
  }

  /** Is `key` at or over its limit right now? Does not count anything. */
  blocked(key: string, win: Window, now = Date.now()): HitResult {
    const e = this.entries.get(key);
    if (!e || e.resetAt <= now || e.count < win.limit) {
      return {
        allowed: true,
        limit: win.limit,
        remaining: Math.max(0, win.limit - (e && e.resetAt > now ? e.count : 0)),
        retryAfterSec: 0,
      };
    }
    return {
      allowed: false,
      limit: win.limit,
      remaining: 0,
      retryAfterSec: Math.max(1, Math.ceil((e.resetAt - now) / 1000)),
    };
  }

  /** Drop expired entries. Returns how many were removed. */
  sweep(now = Date.now()): number {
    let removed = 0;
    for (const [k, e] of this.entries) {
      if (e.resetAt <= now) {
        this.entries.delete(k);
        removed += 1;
      }
    }
    return removed;
  }

  clear(): void {
    this.entries.clear();
  }

  private makeRoom(now: number): void {
    if (this.entries.size < this.maxKeys) return;
    this.sweep(now);
    // Still full of live entries: forget the oldest (Map keeps insertion order).
    while (this.entries.size >= this.maxKeys) {
      const oldest = this.entries.keys().next();
      if (oldest.done) break;
      this.entries.delete(oldest.value);
    }
  }
}
