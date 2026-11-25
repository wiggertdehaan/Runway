import type { Context, Next } from "hono";
import { routePath } from "hono/route";
import { appVisibleTo, getApp } from "../db/apps.js";
import { logDeniedAudit } from "../db/audit.js";
import { safeName } from "../util/audit-detail.js";
import { requiredScope, scopeCovers } from "../util/token-scopes.js";
import { actorKey, type ApiEnv } from "./auth.js";
import { getClientIp } from "./rate-limit.js";

/**
 * What a caller may do on THIS request, after `apiAuth` has said who they are
 * and the rate limiter has counted them (S18).
 *
 * App keys act as before: one app, everything on it, except the routes that
 * only make sense for a person (listing apps, tokens, rebuild, rescan, key
 * rotation), which are refused with a pointer to user tokens.
 *
 * User tokens go through three checks, in this order, each refused with a
 * status that does not say more than it must:
 *   1. the scope covers what the route needs (403)
 *   2. the route needs admin: the person must be an administrator right now (403)
 *   3. an app route names its app (`X-Runway-App`, or `?app=`), and the person
 *      must be allowed to see it; an app that does not exist and one that is
 *      someone else's look the same (404), so ids cannot be probed.
 */

/** Routes (as `/api/v1/pattern`) that are for people with a user token only. */
export const USER_TOKEN_ONLY_ROUTES: ReadonlySet<string> = new Set([
  "/api/v1/me",
  "/api/v1/apps",
  "/api/v1/tokens",
  "/api/v1/tokens/all",
  "/api/v1/tokens/:tokenId",
  "/api/v1/app/rebuild",
  "/api/v1/app/rescan",
  "/api/v1/app/rotate-key",
]);

/** Is this a route about one app (so a user token must say which)? */
export function isAppRoute(pattern: string): boolean {
  return pattern === "/api/v1/app" || pattern.startsWith("/api/v1/app/");
}

function refuse(c: Context, status: 403 | 404 | 400, message: string, reason: string) {
  const actor = c.get("actor");
  try {
    logDeniedAudit({
      actorType: actor?.kind === "user-token" ? "user-token" : "api-key",
      action: "api_forbidden",
      ip: getClientIp(c),
      reason: `${actor ? actorKey(actor) : "unknown"} ${reason}`,
    });
  } catch (err) {
    console.error("audit write failed:", (err as Error).message);
  }
  return c.json({ error: message }, status);
}

export async function apiAuthorize(c: Context<ApiEnv>, next: Next) {
  const actor = c.get("actor");
  if (!actor) return c.json({ error: "Unauthorized" }, 401);
  const pattern = routePath(c, -1);

  if (actor.kind === "app-key") {
    if (USER_TOKEN_ONLY_ROUTES.has(pattern)) {
      return refuse(
        c,
        403,
        "This needs a user token (rwu_…), not an app key.",
        "user_token_only"
      );
    }
    await next();
    return;
  }

  const needed = requiredScope(c.req.method, pattern);
  if (!scopeCovers(actor.scope, needed)) {
    return refuse(c, 403, `This token's scope does not allow that (needs ${needed}).`, `need=${needed}`);
  }
  if (needed === "admin" && actor.role !== "admin") {
    return refuse(c, 403, "Only an administrator may do that.", "need=admin_role");
  }

  if (isAppRoute(pattern)) {
    const wanted = c.req.header("X-Runway-App") ?? c.req.query("app") ?? "";
    const id = safeName(wanted, 40);
    if (!id) {
      return refuse(
        c,
        400,
        "Say which app: send its id in the X-Runway-App header (or ?app=). List yours with GET /api/v1/apps.",
        "no_app"
      );
    }
    const app = getApp(id);
    if (!app || app.deleted_at || !appVisibleTo({ id: actor.userId, role: actor.role }, app)) {
      return refuse(c, 404, "App not found.", `app=${id}`);
    }
    c.set("app", app);
  }

  await next();
}
