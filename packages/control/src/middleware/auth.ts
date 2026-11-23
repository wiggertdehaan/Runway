import type { Context, Next } from "hono";
import { getAppByKey, type App } from "../db/apps.js";
import { logDeniedAudit } from "../db/audit.js";
import { getUser } from "../db/users.js";
import { getUserTokenByToken, touchUserToken } from "../db/user-tokens.js";
import { tokenKindOf } from "../util/token-hash.js";
import type { Scope } from "../util/token-scopes.js";
import { getClientIp } from "./rate-limit.js";
import { guessBlocked, recordWrongKey } from "./token-limit.js";

/**
 * Who is calling the API. Set by `apiAuth`, read by everything after it.
 *
 *  - `app-key`: the per-app key (`rwy_…`). One app, all of it, as before.
 *  - `user-token`: a person's token (`rwu_…`). Every app that person may see,
 *    limited by the token's scope. The person is looked up on every request,
 *    so a deleted user or a changed role takes effect at once.
 */
export type Actor =
  | { kind: "app-key"; appId: string }
  | {
      kind: "user-token";
      tokenId: string;
      userId: string;
      username: string;
      role: string;
      scope: Scope;
    };

export type ApiEnv = { Variables: { app: App; actor: Actor } };

/** The id used to count and to audit this caller (`api-key:<app>` / `user-token:<token>`). */
export function actorKey(actor: Actor): string {
  return actor.kind === "app-key"
    ? `api-key:${actor.appId}`
    : `user-token:${actor.tokenId}`;
}

/** A refused API request, as one counted row per source (see logDeniedAudit). */
function denied(c: Context, reason: string, actorType: "api-key" | "user-token" = "api-key") {
  try {
    logDeniedAudit({
      actorType,
      action: "api_auth_denied",
      ip: getClientIp(c),
      reason,
    });
  } catch (err) {
    console.error("audit write failed:", (err as Error).message);
  }
}

/**
 * Authenticate API requests using a Bearer token: an app API key or a user
 * token. This only establishes WHO is calling. What they may do, and which
 * app a user token is pointed at, is decided by `apiAuthorize` (after the
 * per-token rate limit, so a token that keeps asking for what it may not
 * have is still counted).
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

  const presented = header.slice(7);

  if (tokenKindOf(presented) === "user-token") {
    const token = getUserTokenByToken(presented);
    // A token of a person who has been deleted is gone with them (cascade);
    // the lookup is repeated here so it holds even if that ever changes.
    const user = token ? getUser(token.user_id) : undefined;
    if (!token || !user) {
      recordWrongKey(c);
      denied(c, "unknown_token", "user-token");
      return c.json({ error: "Invalid or expired token" }, 401);
    }
    touchUserToken(token.id);
    c.set("actor", {
      kind: "user-token",
      tokenId: token.id,
      userId: user.id,
      username: user.username,
      role: user.role,
      scope: token.scope,
    } satisfies Actor);
    await next();
    return;
  }

  const app = getAppByKey(presented);
  if (!app) {
    // Only a key that does not exist counts as a guess. A missing header does
    // not, so a monitor without credentials cannot lock its own address out.
    recordWrongKey(c);
    denied(c, "unknown_key");
    return c.json({ error: "Invalid API key" }, 401);
  }

  c.set("app", app);
  c.set("actor", { kind: "app-key", appId: app.id } satisfies Actor);
  await next();
}
