/**
 * S02: where the session cookies live.
 *
 * The dashboard session cookie is host-only: no Domain attribute, so the
 * browser sends it to the dashboard hostname and to nothing else. Before this
 * it was set on `.{base_domain}`, which put a valid dashboard session in front
 * of every deployed app (and so in front of whoever wrote that app's code).
 *
 * Over HTTPS the cookie also gets the `__Host-` prefix: the browser then
 * refuses to store it with a Domain attribute and refuses to let a sibling
 * subdomain overwrite it. The name is chosen per request, and over HTTPS only
 * the prefixed name is read, so a subdomain cannot plant a plain-named cookie
 * (cookie tossing) and have it accepted as a session.
 */
import type { Context } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { getSetting } from "../db/settings.js";

export const SESSION_COOKIE_PLAIN = "runway_session";
export const SESSION_COOKIE_HOST = "__Host-runway_session";
export const SSO_COOKIE_PLAIN = "runway_sso";
export const SSO_COOKIE_HOST = "__Host-runway_sso";

const SESSION_MAX_AGE = 60 * 60 * 24 * 30;
/** A signed-in app visit is good for a working day; the parent session also has to be alive. */
export const SSO_MAX_AGE = 60 * 60 * 8;

export function isSecureRequest(c: Context): boolean {
  const forwarded = c.req.header("x-forwarded-proto");
  if (forwarded) return forwarded.split(",")[0]?.trim() === "https";
  return new URL(c.req.url).protocol === "https:";
}

export function sessionCookieName(secure: boolean): string {
  return secure ? SESSION_COOKIE_HOST : SESSION_COOKIE_PLAIN;
}

export function ssoCookieName(secure: boolean): string {
  return secure ? SSO_COOKIE_HOST : SSO_COOKIE_PLAIN;
}

/** The dashboard session token of this request, or undefined. */
export function readSessionToken(c: Context): string | undefined {
  return getCookie(c, sessionCookieName(isSecureRequest(c))) || undefined;
}

export function setSessionCookie(c: Context, token: string): void {
  const secure = isSecureRequest(c);
  setCookie(c, sessionCookieName(secure), token, {
    httpOnly: true,
    sameSite: "Lax",
    path: "/",
    maxAge: SESSION_MAX_AGE,
    secure,
    // Deliberately no `domain`: host-only.
  });
}

/** Remove the session cookie, and the old domain-wide one if a browser still has it. */
export function clearSessionCookie(c: Context): void {
  const secure = isSecureRequest(c);
  deleteCookie(c, sessionCookieName(secure), { path: "/", secure });
  expireLegacySessionCookie(c, true);
}

/**
 * Before this change the cookie was `runway_session` with Domain=.{base}.
 * Those sessions are purged server-side on upgrade, so a leftover cookie is
 * dead weight; tell the browser to drop it. Only sent when the request still
 * carries one.
 */
export function expireLegacySessionCookie(c: Context, force = false): void {
  const header = c.req.header("cookie") ?? "";
  if (!force && !/(?:^|;\s*)runway_session=/.test(header)) return;
  const secure = isSecureRequest(c);
  if (secure) {
    // Only needed (and only meaningful) over HTTPS, where the live cookie is __Host-.
    deleteCookie(c, SESSION_COOKIE_PLAIN, { path: "/", secure: true });
    const base = getSetting("base_domain");
    if (base) deleteCookie(c, SESSION_COOKIE_PLAIN, { path: "/", secure: true, domain: `.${base}` });
  }
}

export function ssoCookieOptions(secure: boolean) {
  return {
    httpOnly: true,
    sameSite: "Lax" as const,
    path: "/",
    maxAge: SSO_MAX_AGE,
    secure,
  };
}
