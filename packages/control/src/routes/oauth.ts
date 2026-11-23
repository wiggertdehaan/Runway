import { Hono } from "hono";
import { setCookie, getCookie, deleteCookie } from "hono/cookie";
import {
  GOOGLE,
  MICROSOFT,
  buildAuthUrl,
  exchangeCode,
  decodeIdToken,
  isEmailVerified,
  generateState,
  generateNonce,
  generatePkcePair,
  type OAuthProvider,
} from "../auth/oauth.js";
import { timingSafeEqual } from "node:crypto";
import { getSetting } from "../db/settings.js";
import {
  getUserByEmail,
  createOAuthUser,
  bindOAuthIdentity,
  type User,
} from "../db/users.js";
import { decideOAuthLogin, safeReturnTo } from "../auth/oauth-access.js";
import { isAccessAllowed, consumeInvite } from "../db/oauth-access.js";
import { createSession, getSessionUser } from "../db/sessions.js";
import { createSsoTicket, redeemSsoTicket, createSsoSession, getSsoSession } from "../db/sso-sessions.js";
import { getUser } from "../db/users.js";
import {
  readSessionToken,
  setSessionCookie,
  ssoCookieName,
  ssoCookieOptions,
} from "../middleware/cookies.js";
import { getAppByDomain } from "../db/apps.js";
import { isEmailAllowedForApp } from "../db/app-emails.js";
import { logAudit } from "../db/audit.js";
import {
  decideForwardAuth,
  normalizeHost,
  safeAppPath,
  takeTicket,
  withTicket,
  type ForwardAuthDecision,
} from "../auth/forward-auth.js";

export const oauthRoutes = new Hono();

const STATE_COOKIE = "runway_oauth_state";
const NONCE_COOKIE = "runway_oauth_nonce";
const PKCE_COOKIE = "runway_oauth_pkce";
const RETURN_COOKIE = "runway_oauth_return";

function dashboardOrigin(): string {
  const domain = process.env.DASHBOARD_DOMAIN;
  return domain ? `https://${domain}` : "http://localhost:3000";
}

/**
 * Hosts we may send a browser to after login: the dashboard, subdomains of
 * the base domain, and any app's own domain. Everything else is refused.
 */
function isOurHost(host: string): boolean {
  const dash = process.env.DASHBOARD_DOMAIN?.toLowerCase();
  if (dash && host === dash) return true;
  if (!dash && (host === "localhost" || host === "127.0.0.1")) return true;
  const base = getSetting("base_domain")?.toLowerCase();
  if (base && (host === base || host.endsWith(`.${base}`))) return true;
  return !!getAppByDomain(host);
}

export function safeReturn(raw: string | undefined | null): string {
  return safeReturnTo(raw, isOurHost);
}

function isSecureRequest(c: { req: { header: (name: string) => string | undefined } }): boolean {
  return (
    c.req.header("x-forwarded-proto") === "https" ||
    dashboardOrigin().startsWith("https")
  );
}

function getProviderConfig(
  provider: OAuthProvider
): { clientId: string; clientSecret: string } | null {
  const prefix = provider.name === "google" ? "oauth_google" : "oauth_microsoft";
  const clientId = getSetting(`${prefix}_client_id` as any);
  const clientSecret = getSetting(`${prefix}_client_secret` as any);
  if (!clientId || !clientSecret) return null;
  return { clientId, clientSecret };
}

function callbackUrl(provider: OAuthProvider): string {
  return `${dashboardOrigin()}/auth/${provider.name}/callback`;
}

// ── OAuth start ─────────────────────────────────────────

function startHandler(provider: OAuthProvider) {
  return (c: any) => {
    const config = getProviderConfig(provider);
    if (!config) {
      return c.text(`${provider.name} OAuth is not configured`, 500);
    }

    const state = generateState();
    const nonce = generateNonce();
    const pkce = generatePkcePair();
    // S17: only a relative path or one of our own hosts survives.
    const returnTo = safeReturn(c.req.query("return_to"));

    const transientCookie = {
      httpOnly: true,
      sameSite: "Lax" as const,
      path: "/",
      maxAge: 300,
      secure: isSecureRequest(c),
    };

    setCookie(c, STATE_COOKIE, state, transientCookie);
    setCookie(c, NONCE_COOKIE, nonce, transientCookie);
    setCookie(c, PKCE_COOKIE, pkce.verifier, transientCookie);
    setCookie(c, RETURN_COOKIE, returnTo, transientCookie);

    const url = buildAuthUrl(provider, config.clientId, callbackUrl(provider), {
      state,
      nonce,
      codeChallenge: pkce.challenge,
    });
    return c.redirect(url);
  };
}

/**
 * Constant-time cookie comparison. Random 192-bit values make naive
 * string compare safe in practice, but tests and future code may run
 * this against shorter tokens where timing leaks would matter.
 */
function safeCookieEquals(a: string | undefined, b: string | undefined): boolean {
  if (!a || !b) return false;
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

oauthRoutes.get("/auth/google", startHandler(GOOGLE));
oauthRoutes.get("/auth/microsoft", startHandler(MICROSOFT));

// ── OAuth callback ──────────────────────────────────────

function callbackHandler(provider: OAuthProvider) {
  return async (c: any) => {
    const config = getProviderConfig(provider);
    if (!config) {
      return c.text(`${provider.name} OAuth is not configured`, 500);
    }

    // Pull and clear all transient cookies up front — we never want
    // to leak them past this callback, even on an error path.
    const stateParam = c.req.query("state");
    const stateCookie = getCookie(c, STATE_COOKIE);
    const nonceCookie = getCookie(c, NONCE_COOKIE);
    const pkceCookie = getCookie(c, PKCE_COOKIE);
    deleteCookie(c, STATE_COOKIE, { path: "/" });
    deleteCookie(c, NONCE_COOKIE, { path: "/" });
    deleteCookie(c, PKCE_COOKIE, { path: "/" });

    if (!stateParam || !safeCookieEquals(stateParam, stateCookie)) {
      return c.redirect("/login?error=oauth_state");
    }
    if (!pkceCookie) {
      return c.redirect("/login?error=oauth_state");
    }

    const code = c.req.query("code");
    if (!code) {
      return c.redirect("/login?error=oauth_no_code");
    }

    let email: string;
    let sub: string;
    let verified: boolean;
    try {
      const tokens = await exchangeCode(
        provider,
        config.clientId,
        config.clientSecret,
        code,
        callbackUrl(provider),
        pkceCookie
      );
      const claims = decodeIdToken(tokens.id_token);
      if (!claims.nonce || !safeCookieEquals(claims.nonce, nonceCookie)) {
        return c.redirect("/login?error=oauth_nonce");
      }
      if (!claims.email) {
        return c.redirect("/login?error=oauth_no_email");
      }
      email = claims.email.toLowerCase();
      sub = claims.sub;
      verified = isEmailVerified(provider.name, claims);
    } catch (err: any) {
      console.error(`OAuth callback error (${provider.name}):`, err?.message);
      return c.redirect("/login?error=oauth_exchange");
    }

    // S01: an unverified address never signs in or links, and a stranger
    // only gets an account when an admin allowed their address or domain
    // (or invited them). Every refusal looks the same to the visitor; the
    // reason goes to the audit log for the admin.
    const existing = getUserByEmail(email);
    const decision = decideOAuthLogin({
      provider: provider.name,
      sub,
      emailVerified: verified,
      existing: existing
        ? { oauth_provider: existing.oauth_provider, oauth_sub: existing.oauth_sub }
        : null,
      allowed: !existing && verified ? isAccessAllowed(email) : false,
    });
    if (decision.action === "deny") {
      logAudit("unknown", email, "oauth_denied", {
        detail: `provider=${provider.name} reason=${decision.reason}`,
      });
      return c.redirect("/login?error=oauth_denied");
    }

    let user: User;
    if (decision.action === "provision") {
      try {
        user = await createOAuthUser(email, provider.name, sub);
        consumeInvite(email);
        logAudit(user.id, user.username, "user_created_oauth", { detail: `provider=${provider.name}` });
      } catch (err: any) {
        // Race condition: another request created the user
        const raced = getUserByEmail(email);
        if (!raced) throw err;
        user = raced;
      }
    } else {
      user = existing!;
      if (decision.bindIdentity) bindOAuthIdentity(user.id, provider.name, sub);
    }

    // Create session
    const session = createSession(user.id);
    setSessionCookie(c, session.token);

    logAudit(user.id, user.username, "login_oauth", { detail: `provider=${provider.name}` });

    // Validate again: the cookie is ours, but it is the user's to edit.
    const returnTo = safeReturn(getCookie(c, RETURN_COOKIE));
    deleteCookie(c, RETURN_COOKIE, { path: "/" });

    return c.redirect(returnTo);
  };
}

oauthRoutes.get("/auth/google/callback", callbackHandler(GOOGLE));
oauthRoutes.get("/auth/microsoft/callback", callbackHandler(MICROSOFT));

// ── Forward-auth verify ─────────────────────────────────
//
// S02: an app host has its own sign-in, separate from the dashboard session.
//   1. No app cookie: send the visitor to the dashboard (/sso/start), where
//      the host-only dashboard cookie proves who they are.
//   2. The dashboard hands back a one-time ticket in the URL of THIS host.
//   3. Here the ticket is swapped for a cookie that only this host's
//      forward-auth accepts, and the URL is cleaned.
// The dashboard cookie is never sent to an app, and the app cookie is no use
// on the dashboard.

oauthRoutes.get("/auth/verify", (c) => {
  const forwardedHost = c.req.header("x-forwarded-host");
  const forwardedUri = c.req.header("x-forwarded-uri") ?? "/";
  const forwardedProto = c.req.header("x-forwarded-proto") ?? "https";
  const secure = forwardedProto.split(",")[0]?.trim() === "https";
  const host = normalizeHost(forwardedHost);
  const { uri: cleanUri, ticket } = takeTicket(safeAppPath(forwardedUri));

  // Fail closed: any error while deciding (database, parsing) is a "no".
  let decision: ForwardAuthDecision;
  try {
    const app = host ? getAppByDomain(host) : undefined;

    if (ticket !== null && app && app.sso_enabled) {
      const grant = redeemSsoTicket(ticket, host);
      const user = grant && grant.appId === app.id ? getUser(grant.userId) : undefined;
      if (!grant || !user || !user.email || !isEmailAllowedForApp(app.id, user.email)) {
        // Used, expired, for another host, or no longer allowed. No bounce
        // back to the dashboard: with cookies blocked that would loop.
        return c.text(
          "This sign-in link has expired or was already used. Open the app again to sign in.",
          403
        );
      }
      const token = createSsoSession({
        host,
        appId: app.id,
        userId: user.id,
        parentToken: grant.parentToken,
      });
      setCookie(c, ssoCookieName(secure), token, ssoCookieOptions(secure));
      logAudit(user.id, user.username, "sso_login", { detail: `app=${app.id} host=${host}` });
      return c.redirect(`${forwardedProto.split(",")[0]?.trim() || "https"}://${host}${cleanUri}`, 302);
    }

    const raw = getCookie(c, ssoCookieName(secure));
    const grant = raw && app ? getSsoSession(raw, host) : undefined;
    const user = grant && app && grant.appId === app.id ? getUser(grant.userId) : undefined;
    decision = decideForwardAuth({
      host,
      app,
      hasSession: !!user,
      user,
      emailAllowed: isEmailAllowedForApp,
    });
  } catch (err) {
    console.error("forward-auth failed, denying:", err);
    return c.text("Forbidden", 403);
  }

  if (decision.action === "deny") return c.text(decision.message, decision.status);
  if (decision.action === "login") {
    return c.redirect(ssoStartUrl(host, cleanUri), 302);
  }
  c.header("X-Forwarded-User", decision.user);
  return c.text("OK", 200);
});

function ssoStartUrl(host: string, uri: string): string {
  return `${dashboardOrigin()}${ssoStartPath(host, uri)}`;
}

function ssoStartPath(host: string, uri: string): string {
  return `/sso/start?host=${encodeURIComponent(host)}&uri=${encodeURIComponent(uri)}`;
}

/**
 * Dashboard side of the handshake. Needs the host-only dashboard session; the
 * target must be a known SSO app host (its Runway address or its custom
 * domain), which is what keeps this from being an open redirect.
 */
oauthRoutes.get("/sso/start", (c) => {
  const host = normalizeHost(c.req.query("host"));
  const uri = safeAppPath(c.req.query("uri"));
  const app = host ? getAppByDomain(host) : undefined;
  if (!app || !app.sso_enabled) return c.text("Forbidden", 403);

  const token = readSessionToken(c);
  const user = token ? getSessionUser(token) : undefined;
  if (!token || !user) {
    return c.redirect(`/login?return_to=${encodeURIComponent(ssoStartPath(host, uri))}`, 302);
  }
  if (!user.email || !isEmailAllowedForApp(app.id, user.email)) {
    return c.text("Forbidden: your email is not in the allowlist for this app", 403);
  }

  const ticket = createSsoTicket({ host, appId: app.id, userId: user.id, dashboardToken: token });
  const scheme = dashboardOrigin().startsWith("https") ? "https" : "http";
  return c.redirect(`${scheme}://${host}${withTicket(uri, ticket)}`, 302);
});
