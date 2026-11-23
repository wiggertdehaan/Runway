import type { Context, Next } from "hono";
import { getAppByKey } from "../db/apps.js";
import { logDeniedAudit } from "../db/audit.js";
import { getClientIp } from "./rate-limit.js";
import { guessBlocked, recordWrongKey } from "./token-limit.js";

/** A refused API request, as one counted row per source (see logDeniedAudit). */
function denied(c: Context, reason: string) {
  try {
    logDeniedAudit({
      actorType: "api-key",
      action: "api_auth_denied",
      ip: getClientIp(c),
      reason,
    });
  } catch (err) {
    console.error("audit write failed:", (err as Error).message);
  }
}

/**
 * Authenticate API requests using Bearer token (app API key).
 * Sets the app on the context for downstream handlers.
 */
export async function apiAuth(c: Context, next: Next) {
  // S21: a source that has already guessed wrong too often is refused before
  // its key is even looked at, so a lucky guess teaches it nothing.
  const blocked = guessBlocked(c, "api-key");
  if (blocked) return blocked;

  const header = c.req.header("Authorization");
  if (!header?.startsWith("Bearer ")) {
    denied(c, "missing_header");
    return c.json({ error: "Missing or invalid Authorization header" }, 401);
  }

  const key = header.slice(7);
  const app = getAppByKey(key);
  if (!app) {
    // Only a key that does not exist counts as a guess. A missing header does
    // not, so a monitor without credentials cannot lock its own address out.
    recordWrongKey(c);
    denied(c, "unknown_key");
    return c.json({ error: "Invalid API key" }, 401);
  }

  c.set("app", app);
  await next();
}
