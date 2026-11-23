/**
 * Pure rules for who may sign in with Google or Microsoft, and where they
 * may be sent afterwards. No database, no network: the callers pass in what
 * they looked up.
 */

export type AccessKind = "email" | "domain";

export interface AccessEntry {
  kind: AccessKind;
  /** Lowercase address (kind=email) or domain without "@" (kind=domain). */
  value: string;
}

const EMAIL_RE = /^[^\s@<>"',;]+@[^\s@<>"',;]+\.[^\s@<>"',;]+$/;
const DOMAIN_RE = /^(?=.{3,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;

/**
 * Turn what an admin typed into an entry: "ann@example.com" is an address,
 * "@example.com" or "example.com" a whole domain. Returns null when it is
 * neither.
 */
export function parseAccessEntry(raw: string): AccessEntry | null {
  const v = raw.trim().toLowerCase();
  if (!v || v.length > 254) return null;
  if (v.includes("@") && !v.startsWith("@")) {
    return EMAIL_RE.test(v) ? { kind: "email", value: v } : null;
  }
  const d = v.replace(/^@/, "").replace(/\.$/, "");
  return DOMAIN_RE.test(d) ? { kind: "domain", value: d } : null;
}

export function emailDomain(email: string): string {
  const at = email.lastIndexOf("@");
  return at < 0 ? "" : email.slice(at + 1).toLowerCase();
}

export function matchesAccess(entries: AccessEntry[], email: string): boolean {
  const e = email.trim().toLowerCase();
  const d = emailDomain(e);
  return entries.some((x) =>
    x.kind === "email" ? x.value === e : x.value === d
  );
}

export type DenyReason =
  | "unverified_email"
  | "not_invited"
  | "identity_mismatch";

export type LoginDecision =
  | { action: "login"; bindIdentity: boolean }
  | { action: "provision" }
  | { action: "deny"; reason: DenyReason };

export interface DecideInput {
  provider: string;
  /** `sub` claim of this login. */
  sub: string;
  emailVerified: boolean;
  /** The account that already has this address, if any. */
  existing: {
    oauth_provider: string | null;
    oauth_sub: string | null;
  } | null;
  /** True when the address is on the allowlist or has an open invitation. */
  allowed: boolean;
}

/**
 * One decision for every OAuth login:
 *  - an unverified address never signs in, never links, never provisions;
 *  - an existing account signs in (and is pinned to this provider identity
 *    on first use; later logins must present the same one);
 *  - an unknown address is provisioned only when the admin allowed it.
 */
export function decideOAuthLogin(i: DecideInput): LoginDecision {
  if (!i.emailVerified || !i.sub) {
    return { action: "deny", reason: "unverified_email" };
  }
  if (i.existing) {
    if (i.existing.oauth_sub) {
      if (
        i.existing.oauth_provider !== i.provider ||
        i.existing.oauth_sub !== i.sub
      ) {
        return { action: "deny", reason: "identity_mismatch" };
      }
      return { action: "login", bindIdentity: false };
    }
    return { action: "login", bindIdentity: true };
  }
  return i.allowed
    ? { action: "provision" }
    : { action: "deny", reason: "not_invited" };
}

/**
 * Where may we send someone after login? Only to a relative path on this
 * dashboard, or to a host the caller says is ours (the dashboard itself, a
 * subdomain of the base domain, an app's own domain). Anything else falls
 * back to "/". Never returns a value that a browser could read as another
 * origin ("//evil", "/\evil", "https://evil", "javascript:").
 */
export function safeReturnTo(
  raw: string | undefined | null,
  isOurHost: (host: string) => boolean
): string {
  if (!raw || raw.length > 2048) return "/";
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f\\]/.test(raw)) return "/";
  if (raw.startsWith("/")) {
    return raw.startsWith("//") ? "/" : raw;
  }
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return "/";
  }
  if (u.protocol !== "https:" && u.protocol !== "http:") return "/";
  if (u.username || u.password) return "/";
  return isOurHost(u.hostname.toLowerCase().replace(/\.$/, "")) ? u.toString() : "/";
}
