import type { MiddlewareHandler } from "hono";
import { normalizeHost } from "../auth/forward-auth.js";

/**
 * Two routes exist only for Traefik and the gateway, never for a browser on
 * the dashboard's own address:
 *
 * - `/auth/verify`: called by Traefik's forwardAuth for an SSO app. Reached
 *   from the internet it was an oracle: anyone could ask it about any host.
 * - `/maintenance`: the page an app's hosts are rewritten to while the app is
 *   quarantined.
 *
 * Traefik reaches both through the service URL (http://control:3000), so the
 * request carries the app's host (maintenance) or `control:3000` (forward
 * auth) in its Host header. A request that carries the DASHBOARD's host came
 * in through the public dashboard router, and is refused with a plain 404.
 * The gateway config (deploy/gateway.ts) also denies these paths on the
 * dashboard host; this is the second lock, so a missing or stale gateway file
 * does not reopen them.
 */
const INTERNAL_PATH = /^\/(auth\/verify|maintenance)\/*$/;

export function isInternalRoute(path: string): boolean {
  return INTERNAL_PATH.test(path);
}

/** The host a request was addressed to: the Host header, else the URL's. */
export function requestHost(hostHeader: string | undefined, url: string): string {
  const fromHeader = normalizeHost(hostHeader);
  if (fromHeader) return fromHeader;
  try {
    return normalizeHost(new URL(url).host);
  } catch {
    return "";
  }
}

export function isDashboardHost(host: string, dashboardDomain: string | undefined): boolean {
  const dashboard = normalizeHost(dashboardDomain);
  return dashboard !== "" && host === dashboard;
}

export const keepInternalRoutesOffTheDashboardHost: MiddlewareHandler = async (c, next) => {
  if (isInternalRoute(c.req.path) && isDashboardHost(requestHost(c.req.header("host"), c.req.url), process.env.DASHBOARD_DOMAIN)) {
    return c.text("Not found", 404);
  }
  await next();
};
