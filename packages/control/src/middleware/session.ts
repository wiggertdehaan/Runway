import type { Context, Next } from "hono";
import { getCookie } from "hono/cookie";
import { getSessionUser } from "../db/sessions.js";
import { countUsers } from "../db/users.js";
import type { User } from "../db/users.js";

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
