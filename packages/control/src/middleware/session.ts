import type { Context, Next } from "hono";
import { readSessionToken } from "./cookies.js";
import { getSessionUser } from "../db/sessions.js";
import { countUsers, isAdmin } from "../db/users.js";
import type { User } from "../db/users.js";
import { getApp, isAppOwner } from "../db/apps.js";

export type WebEnv = { Variables: { user: User } };

/**
 * Require an authenticated web session. Redirects:
 *   - to /setup if no users exist yet (first-run)
 *   - to /login if not signed in
 */
export async function requireSession(c: Context<WebEnv>, next: Next) {
  if (countUsers() === 0) {
    return c.redirect("/setup");
  }

  const token = readSessionToken(c);
  if (!token) return c.redirect("/login");

  const user = getSessionUser(token);
  if (!user) return c.redirect("/login");

  c.set("user", user);
  await next();
}

/**
 * Chain after requireSession: block member accounts from admin-only
 * routes (user management, server settings, audit, health).
 */
export async function requireAdmin(c: Context<WebEnv>, next: Next) {
  const user = c.get("user");
  if (!user || !isAdmin(user)) {
    return c.redirect("/?forbidden=1");
  }
  await next();
}

/**
 * Chain after requireSession on /apps/:id[/*]: allow access only when
 * the user is admin or owns the app (by user id, never by name). Apps
 * without an owner (pre-v0.3 rows, or the owner was deleted) are
 * admin-only.
 */
export async function requireAppAccess(c: Context<WebEnv>, next: Next) {
  const user = c.get("user");
  const id = c.req.param("id");
  if (!user || !id) return c.redirect("/?forbidden=1");
  if (isAdmin(user)) return next();
  const app = getApp(id);
  if (!app || !isAppOwner(user, app)) {
    return c.redirect("/?forbidden=1");
  }
  await next();
}
