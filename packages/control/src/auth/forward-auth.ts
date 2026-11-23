/**
 * The forward-auth decision for SSO apps, as a pure function so every
 * fail-closed branch can be asserted. Traefik calls /auth/verify for each
 * request to an SSO app and serves the request only on a 200.
 *
 * Rule: a 200 needs an app answering to this hostname (its Runway address or
 * its custom domain), SSO on for it, a valid app-host sign-in and an allowed
 * email. Everything else is a login redirect (nobody
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
  if (!input.hasSession || !input.user) return { action: "login" };
  if (!input.user.email) {
    return { action: "deny", status: 403, message: "Forbidden: no email linked to your account" };
  }
  if (!input.emailAllowed(app.id, input.user.email)) {
    return { action: "deny", status: 403, message: "Forbidden: your email is not in the allowlist for this app" };
  }
  return { action: "allow", user: input.user.email };
}


/** The query parameter that carries a one-time sign-in ticket back to an app host. */
export const TICKET_PARAM = "__runway_ticket";

/**
 * A path-and-query we are willing to send a browser back to on an app host:
 * it must be a plain absolute path. Anything else (a full URL, "//host",
 * backslashes, control characters, absurd length) becomes "/", so the
 * handshake can never be steered to another site.
 */
export function safeAppPath(raw: string | undefined | null): string {
  if (!raw || raw.length > 2048) return "/";
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f\\]/.test(raw)) return "/";
  if (!raw.startsWith("/") || raw.startsWith("//")) return "/";
  return raw;
}

/** Split the ticket out of a forwarded URI, returning the URI as the visitor asked for it. */
export function takeTicket(uri: string): { uri: string; ticket: string | null } {
  const q = uri.indexOf("?");
  if (q === -1) return { uri, ticket: null };
  const path = uri.slice(0, q);
  const params = new URLSearchParams(uri.slice(q + 1));
  const ticket = params.get(TICKET_PARAM);
  if (ticket === null) return { uri, ticket: null };
  params.delete(TICKET_PARAM);
  const rest = params.toString();
  return { uri: rest ? `${path}?${rest}` : path, ticket };
}

/** Add the ticket to a path-and-query. */
export function withTicket(path: string, ticket: string): string {
  const q = path.indexOf("?");
  const base = q === -1 ? path : path.slice(0, q);
  const params = new URLSearchParams(q === -1 ? "" : path.slice(q + 1));
  params.set(TICKET_PARAM, ticket);
  return `${base}?${params.toString()}`;
}
