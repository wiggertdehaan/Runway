import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { Hono } from "hono";

/**
 * Self-hosted htmx. The dashboard used to load htmx from unpkg without
 * an integrity hash, which put a third party into the login page: a
 * compromised CDN response would run with the admin's session. Now the
 * exact file from the pinned `htmx.org` dependency (checked by the
 * lockfile integrity hash at install time) is served from our own
 * origin, and the page tag carries an SRI hash of it as well.
 */
const require = createRequire(import.meta.url);
const htmxSource = readFileSync(require.resolve("htmx.org/dist/htmx.min.js"));
const htmxVersion: string = JSON.parse(
  readFileSync(require.resolve("htmx.org/package.json"), "utf8")
).version;

export const HTMX_PATH = `/assets/htmx-${htmxVersion}.min.js`;
export const HTMX_INTEGRITY = `sha384-${createHash("sha384").update(htmxSource).digest("base64")}`;

export const assetRoutes = new Hono();

// The version is part of the URL, so the response can be cached for good.
assetRoutes.get(HTMX_PATH, (c) => {
  c.header("Content-Type", "text/javascript; charset=utf-8");
  c.header("Cache-Control", "public, max-age=31536000, immutable");
  return c.body(htmxSource);
});
