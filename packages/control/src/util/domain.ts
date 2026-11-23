import { getSetting } from "../db/settings.js";
import { isDomainTaken } from "../db/apps.js";
import { normalizeHost } from "../db/domain-index.js";

export type CustomDomainError = "format" | "reserved" | "conflict";
export type CustomDomainResult =
  | { ok: true; domain: string | null }
  | { ok: false; error: CustomDomainError };

/**
 * Validate a user-supplied custom_domain before it is stored and handed
 * to Traefik. Rejects:
 *
 *   - malformed domain names
 *   - the dashboard's own hostname (DASHBOARD_DOMAIN) and any subdomain
 *     under the configured base_domain — those are reserved for the
 *     control plane and for auto-generated app subdomains respectively
 *   - domains already claimed by another app (either as their generated
 *     subdomain or as a custom_domain) — Traefik would resolve the
 *     conflict with last-writer-wins, which lets one app hijack another
 *
 * `appId` is the app being updated; matches against its own existing
 * domain/custom_domain are allowed (idempotent saves).
 */
export function validateCustomDomain(
  raw: string,
  appId: string
): CustomDomainResult {
  const trimmed = normalizeHost(raw);
  if (!trimmed) return { ok: true, domain: null };

  if (!/^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$/.test(trimmed)) {
    return { ok: false, error: "format" };
  }

  const dashboardDomain = (process.env.DASHBOARD_DOMAIN ?? "").toLowerCase();
  if (dashboardDomain && trimmed === dashboardDomain) {
    return { ok: false, error: "reserved" };
  }

  const baseDomain = (getSetting("base_domain") ?? "").toLowerCase();
  if (baseDomain) {
    if (trimmed === baseDomain) return { ok: false, error: "reserved" };
    if (trimmed.endsWith(`.${baseDomain}`)) {
      return { ok: false, error: "reserved" };
    }
  }

  if (isDomainTaken(trimmed, appId)) {
    return { ok: false, error: "conflict" };
  }

  return { ok: true, domain: trimmed };
}

export type GeneratedDomainError = "reserved" | "conflict";

/**
 * Check the subdomain generated from an app's name (slug.base_domain)
 * before /app/configure stores it. Two apps with the same name would
 * otherwise get the same hostname (S03). The caller's own current domain
 * is fine (re-configuring with the same name). The answer carries no
 * information about the other app, only that the name is not available.
 */
export function checkGeneratedDomain(
  domain: string,
  appId: string
): GeneratedDomainError | null {
  const host = normalizeHost(domain);
  const dashboardDomain = normalizeHost(process.env.DASHBOARD_DOMAIN ?? "");
  if (dashboardDomain && host === dashboardDomain) return "reserved";
  if (isDomainTaken(host, appId)) return "conflict";
  return null;
}

/** A write that lost a race against the unique index. */
export function isUniqueViolation(err: unknown): boolean {
  return err instanceof Error && /UNIQUE constraint failed/i.test(err.message);
}
