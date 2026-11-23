import { Hono } from "hono";
import { faviconSvg, getInstanceIdentity } from "../instance/identity.js";

/**
 * Public, display-only routes that say which Runway this is.
 *
 * `/instance.json` has exactly two fields, the same two that the login page
 * already shows to anyone: no version, host, count or user. It is read without
 * a session on purpose, so a tool can tell servers apart before it has a
 * credential. CORS is not opened: a web page on another origin cannot read it.
 * It is for display; nothing may route or decide on it.
 */
export const instanceRoutes = new Hono();

instanceRoutes.get("/instance.json", (c) => {
  const { name, color } = getInstanceIdentity();
  c.header("Cache-Control", "public, max-age=60");
  return c.json({ name, color });
});

// The query string (`?v=<colour>`) only makes browsers fetch it again after a change.
instanceRoutes.get("/favicon.svg", (c) => {
  c.header("Content-Type", "image/svg+xml; charset=utf-8");
  c.header("Cache-Control", "public, max-age=300");
  return c.body(faviconSvg(getInstanceIdentity().color));
});
