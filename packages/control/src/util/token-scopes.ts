/**
 * Scopes of a user token (S18) and the rule that turns a request into the
 * scope it needs.
 *
 * Three levels, each including the ones below it:
 *   read    look at apps the person may see: status, config, scan, deploys, logs
 *   deploy  change those apps: deploy, configure, env, domain, rebuild, rescan, rotate their key
 *   admin   things only an administrator does, and only if the person IS one
 *           (checked on every request, so a demoted administrator's admin
 *           tokens stop working at once): any user's tokens, and the key of
 *           an app that is not theirs
 *
 * The scope limits what a token can do; it never grants more than the person
 * could do in the dashboard. The rights themselves (`appsVisibleTo`,
 * `mayRebuild`, `mayRescan`) are evaluated on every request.
 */

export type Scope = "read" | "deploy" | "admin";

export const SCOPES: readonly Scope[] = ["read", "deploy", "admin"];

const RANK: Record<Scope, number> = { read: 1, deploy: 2, admin: 3 };

export function isScope(value: unknown): value is Scope {
  return typeof value === "string" && (SCOPES as readonly string[]).includes(value);
}

/** Does a token with scope `held` cover a request that needs `needed`? */
export function scopeCovers(held: string, needed: Scope): boolean {
  return isScope(held) && RANK[held] >= RANK[needed];
}

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

/**
 * The scope a request needs. Anything that is not a plain read needs `deploy`,
 * so a route added later is never a free read by accident. The admin-only
 * routes are named explicitly.
 */
export function requiredScope(method: string, routePattern: string): Scope {
  if (ADMIN_ROUTES.has(`${method.toUpperCase()} ${routePattern}`)) return "admin";
  return SAFE_METHODS.has(method.toUpperCase()) ? "read" : "deploy";
}

/**
 * Routes (as `METHOD /api/v1/pattern`) that need the admin scope outright.
 * Two routes are deliberately NOT here because who may use them depends on
 * whose token or app it is, which a route pattern cannot say: revoking a
 * token (your own with deploy, anybody's with admin) and rotating an app key
 * (your own app with deploy, anybody's with admin). Their handlers decide.
 */
export const ADMIN_ROUTES: ReadonlySet<string> = new Set(["GET /api/v1/tokens/all"]);

/** Default and longest lifetime of a new user token, in days. */
export const USER_TOKEN_DEFAULT_DAYS = 90;
export const USER_TOKEN_MAX_DAYS = 365;
/** Tokens one person may hold at once; keeps the list and the lookup small. */
export const USER_TOKEN_MAX_PER_USER = 20;

/** The scopes a person may be given: admin only if they are an administrator. */
export function grantableScopes(role: string): Scope[] {
  return role === "admin" ? ["read", "deploy", "admin"] : ["read", "deploy"];
}
