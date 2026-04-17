import { Hono } from "hono";
import { setCookie, getCookie, deleteCookie } from "hono/cookie";
import {
  GOOGLE,
  MICROSOFT,
  buildAuthUrl,
  exchangeCode,
  decodeIdToken,
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
  type User,
} from "../db/users.js";
import { createSession, getSessionUser } from "../db/sessions.js";
import { getAppByDomain } from "../db/apps.js";
import { isEmailAllowedForApp } from "../db/app-emails.js";
import { logAudit } from "../db/audit.js";

export const oauthRoutes = new Hono();

const STATE_COOKIE = "runway_oauth_state";
const NONCE_COOKIE = "runway_oauth_nonce";
const PKCE_COOKIE = "runway_oauth_pkce";
const RETURN_COOKIE = "runway_oauth_return";
const SESSION_COOKIE = "runway_session";

function dashboardOrigin(): string {
  const domain = process.env.DASHBOARD_DOMAIN;
  return domain ? `https://${domain}` : "http://localhost:3000";
}

function isSecureRequest(c: { req: { header: (name: string) => string | undefined } }): boolean {
  return (
    c.req.header("x-forwarded-proto") === "https" ||
    dashboardOrigin().startsWith("https")
  );
}

function sessionCookieOptions(c: { req: { header: (name: string) => string | undefined } }) {
  const baseDomain = getSetting("base_domain");
  return {
    httpOnly: true,
    sameSite: "Lax" as const,
    path: "/",
    maxAge: 60 * 60 * 24 * 30,
    secure: isSecureRequest(c),
    ...(baseDomain ? { domain: `.${baseDomain}` } : {}),
  };
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
    const returnTo = c.req.query("return_to") ?? "/";

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
    } catch (err: any) {
      console.error(`OAuth callback error (${provider.name}):`, err?.message);
      return c.redirect("/login?error=oauth_exchange");
    }

    // Look up or provision user
    let user: User | undefined = getUserByEmail(email);
    if (!user) {
      try {
        user = await createOAuthUser(email, provider.name);
        logAudit(user.id, user.username, "user_created_oauth", { detail: `provider=${provider.name}` });
      } catch (err: any) {
        // Race condition: another request created the user
        user = getUserByEmail(email);
        if (!user) throw err;
      }
    }

    // Create session
    const session = createSession(user.id);
    setCookie(c, SESSION_COOKIE, session.token, sessionCookieOptions(c));

    logAudit(user.id, user.username, "login_oauth", { detail: `provider=${provider.name}` });

    const returnTo = getCookie(c, RETURN_COOKIE) ?? "/";
    deleteCookie(c, RETURN_COOKIE, { path: "/" });

    return c.redirect(returnTo);
  };
}

oauthRoutes.get("/auth/google/callback", callbackHandler(GOOGLE));
oauthRoutes.get("/auth/microsoft/callback", callbackHandler(MICROSOFT));

// ── Forward-auth verify ─────────────────────────────────

oauthRoutes.get("/auth/verify", (c) => {
  const forwardedHost = c.req.header("x-forwarded-host");
  const forwardedUri = c.req.header("x-forwarded-uri") ?? "/";
  const forwardedProto = c.req.header("x-forwarded-proto") ?? "https";

  if (!forwardedHost) {
    return c.text("OK", 200);
  }

  const app = getAppByDomain(forwardedHost);
  if (!app || !app.sso_enabled) {
    return c.text("OK", 200);
  }

  const token = getCookie(c, SESSION_COOKIE);
  if (!token) {
    return redirectToLogin(c, forwardedProto, forwardedHost, forwardedUri);
  }

  const user = getSessionUser(token);
  if (!user) {
    return redirectToLogin(c, forwardedProto, forwardedHost, forwardedUri);
  }

  if (!user.email) {
    return c.text("Forbidden: no email linked to your account", 403);
  }

  if (!isEmailAllowedForApp(app.id, user.email)) {
    return c.text("Forbidden: your email is not in the allowlist for this app", 403);
  }

  // Authorized — inject user header for the app
  c.header("X-Forwarded-User", user.email);
  return c.text("OK", 200);
});

function redirectToLogin(
  c: any,
  proto: string,
  host: string,
  uri: string
) {
  const returnTo = `${proto}://${host}${uri}`;
  const loginUrl = `${dashboardOrigin()}/login?return_to=${encodeURIComponent(returnTo)}`;
  return c.redirect(loginUrl, 302);
}
