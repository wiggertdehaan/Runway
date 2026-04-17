import type { Context, Next } from "hono";
import { getAppByKey } from "../db/apps.js";

/**
 * Authenticate API requests using Bearer token (app API key).
 * Sets the app on the context for downstream handlers.
 */
export async function apiAuth(c: Context, next: Next) {
  const header = c.req.header("Authorization");
  if (!header?.startsWith("Bearer ")) {
    return c.json({ error: "Missing or invalid Authorization header" }, 401);
  }

  const key = header.slice(7);
  const app = getAppByKey(key);
  if (!app) {
    return c.json({ error: "Invalid API key" }, 401);
  }

  c.set("app", app);
  await next();
}
