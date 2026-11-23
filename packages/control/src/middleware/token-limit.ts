import type { Context, Next } from "hono";
import { actorKey, type ApiEnv } from "./auth.js";
import { logDeniedAudit } from "../db/audit.js";
import { getClientIp } from "./rate-limit.js";
import {
  classifyRequest,
  FixedWindowCounter,
  limitsFromEnv,
  type Bucket,
  type LimitConfig,
} from "../util/token-limit.js";

/**
 * S21: allowances per token, plus a cap on wrong key guesses per source.
 *
 * The per-IP limiter in rate-limit.ts stays as a coarse flood guard, but one
 * office address is many people (and one person may have many keys), so the
 * allowance that matters is the one per key. The actor string is generic
 * (`api-key:<app id>` today); user tokens and MCP tokens use the same limiter
 * under their own prefix.
 */

/** Allowances per actor and bucket. Separate from the failed-guess counter. */
const tokenCounter = new FixedWindowCounter();
/** Wrong keys per source address. */
const guessCounter = new FixedWindowCounter();

/** Read on every use, so a test (or an operator, after a restart) can change them. */
export function currentLimits(): LimitConfig {
  return limitsFromEnv(process.env);
}

/** Retry-After for a refusal, as a header value. */
function retryHeaders(retryAfterSec: number): Record<string, string> {
  return { "Retry-After": String(retryAfterSec) };
}

/**
 * The 429 answer. Says only how long to wait: not which bucket, which limit or
 * how many requests were counted.
 */
export function tooManyRequests(c: Context, retryAfterSec: number): Response {
  return c.json(
    {
      error: `Too many requests. Try again in ${retryAfterSec} second${retryAfterSec === 1 ? "" : "s"}.`,
      retry_after: retryAfterSec,
    },
    429,
    retryHeaders(retryAfterSec)
  );
}

function auditDenied(
  c: Context,
  actorType: "api-key" | "mcp" | "user-token",
  action: string,
  reason: string
): void {
  try {
    logDeniedAudit({ actorType, action, ip: getClientIp(c), reason });
  } catch (err) {
    // The refusal still stands; a broken audit write must not turn it into a 500.
    console.error("audit write failed:", (err as Error).message);
  }
}

/**
 * Count one request for `actor` in `bucket`. Returns a 429 response when the
 * allowance is used up (and audits it as one counted row), otherwise null.
 */
export function enforceTokenLimit(
  c: Context,
  actor: string,
  bucket: Bucket,
  actorType: "api-key" | "mcp" | "user-token"
): Response | null {
  const win = currentLimits()[bucket];
  const r = tokenCounter.hit(`${actor}|${bucket}`, win);
  if (r.allowed) return null;
  // The actor id is an app or token id (not a secret) and is what an
  // administrator needs to see; it is part of the aggregation key.
  auditDenied(c, actorType, "api_token_rate_limited", `actor=${actor} bucket=${bucket}`);
  return tooManyRequests(c, r.retryAfterSec);
}

/** After `apiAuth`: the per-key (or per-user-token) allowance for the API. */
export async function apiTokenLimit(c: Context<ApiEnv>, next: Next) {
  const actor = c.get("actor");
  // apiAuth always sets it; without an identity there is nothing to count
  // against, and the request is not let through either way.
  if (!actor) return c.json({ error: "Unauthorized" }, 401);
  const bucket = classifyRequest(c.req.method, c.req.path);
  const refused = enforceTokenLimit(
    c,
    actorKey(actor),
    bucket,
    actor.kind === "app-key" ? "api-key" : "user-token"
  );
  if (refused) return refused;
  await next();
}

/**
 * Before a key is looked up: has this source already guessed wrong too often?
 * Checked first so a guesser learns nothing from a lucky hit while blocked.
 */
export function guessBlocked(
  c: Context,
  actorType: "api-key" | "mcp" | "user-token"
): Response | null {
  const ip = getClientIp(c);
  const r = guessCounter.blocked(`auth|${ip}`, currentLimits().authFail);
  if (r.allowed) return null;
  auditDenied(c, actorType, "auth_guess_blocked", "reason=too_many_wrong_keys");
  return tooManyRequests(c, r.retryAfterSec);
}

/** A key that does not exist was presented from this source. */
export function recordWrongKey(c: Context): void {
  guessCounter.record(`auth|${getClientIp(c)}`, currentLimits().authFail);
}

/** Hourly: drop expired counters so the maps stay small. */
export function sweepTokenLimits(): void {
  tokenCounter.sweep();
  guessCounter.sweep();
}

/** For tests. */
export function resetTokenLimits(): void {
  tokenCounter.clear();
  guessCounter.clear();
}

export function tokenLimitSizes(): { tokens: number; guesses: number } {
  return { tokens: tokenCounter.size, guesses: guessCounter.size };
}
