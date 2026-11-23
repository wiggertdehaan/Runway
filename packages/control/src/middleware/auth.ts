import type { Context, Next } from "hono";
import { getAppByKey } from "../db/apps.js";
import { logDeniedAudit } from "../db/audit.js";
import { getClientIp } from "./rate-limit.js";

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
  const header = c.req.header("Authorization");
  if (!header?.startsWith("Bearer ")) {
    denied(c, "missing_header");
    return c.json({ error: "Missing or invalid Authorization header" }, 401);
  }

  const key = header.slice(7);
  const app = getAppByKey(key);
  if (!app) {
    denied(c, "unknown_key");
    return c.json({ error: "Invalid API key" }, 401);
  }

  c.set("app", app);
  await next();
}
