/**
 * The forward-auth decision for SSO apps, as a pure function so every
 * fail-closed branch can be asserted. Traefik calls /auth/verify for each
 * request to an SSO app and serves the request only on a 200.
 *
 * Rule: a 200 needs an app, SSO on for it, the app's own hostname, a valid
 * session and an allowed email. Everything else is a login redirect (nobody
 * signed in yet) or a 403. A missing host, an unknown host or an app that has
 * SSO off means the gateway config is stale or wrong, and the answer to that
 * is "no", never "come in".
 */

export interface ForwardAuthApp {
  id: string;
  domain: string | null;
  sso_enabled: number;
}

export type ForwardAuthDecision =
  | { action: "allow"; user: string }
  | { action: "login" }
  | { action: "deny"; status: 403; message: string };

/** Lowercase, drop a port and a trailing dot so host comparisons are stable. */
export function normalizeHost(raw: string | undefined | null): string {
  if (!raw) return "";
  return raw.trim().toLowerCase().replace(/:\d+$/, "").replace(/\.$/, "");
}

export function decideForwardAuth(input: {
  host: string | undefined | null;
  app: ForwardAuthApp | undefined;
  hasSession: boolean;
  user: { email: string | null } | undefined;
  emailAllowed: (appId: string, email: string) => boolean;
}): ForwardAuthDecision {
  const host = normalizeHost(input.host);
  if (!host) {
    return { action: "deny", status: 403, message: "Forbidden: no host" };
  }
  const app = input.app;
  if (!app) {
    return { action: "deny", status: 403, message: "Forbidden: unknown host" };
  }
  if (!app.sso_enabled) {
    return { action: "deny", status: 403, message: "Forbidden: SSO is not enabled for this app" };
  }
  // The session cookie is scoped to the base domain, so it never reaches a
  // custom domain. Sending the visitor to log in would loop forever, so say
  // so instead. (Their own subdomain keeps working.)
  if (normalizeHost(app.domain) !== host) {
    return {
      action: "deny",
      status: 403,
      message:
        "Forbidden: SSO is only available on this app's Runway address, not on a custom domain. " +
        "Ask the administrator to turn off SSO or remove the custom domain.",
    };
  }
  if (!input.hasSession || !input.user) return { action: "login" };
  if (!input.user.email) {
    return { action: "deny", status: 403, message: "Forbidden: no email linked to your account" };
  }
  if (!input.emailAllowed(app.id, input.user.email)) {
    return { action: "deny", status: 403, message: "Forbidden: your email is not in the allowlist for this app" };
  }
  return { action: "allow", user: input.user.email };
}
