import type { Context, Next } from "hono";
import { getCookie } from "hono/cookie";
import { getSessionUser } from "../db/sessions.js";
import { countUsers, isAdmin } from "../db/users.js";
import type { User } from "../db/users.js";
import { getApp } from "../db/apps.js";

export const SESSION_COOKIE = "runway_session";

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

  const token = getCookie(c, SESSION_COOKIE);
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
 * the user is admin or the app was created by them. Apps with a NULL
 * created_by (pre-v0.3 rows) are treated as admin-only.
 */
export async function requireAppAccess(c: Context<WebEnv>, next: Next) {
  const user = c.get("user");
  const id = c.req.param("id");
  if (!user || !id) return c.redirect("/?forbidden=1");
  if (isAdmin(user)) return next();
  const app = getApp(id);
  if (!app || app.created_by !== user.username) {
    return c.redirect("/?forbidden=1");
  }
  await next();
}
