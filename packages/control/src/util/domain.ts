import { getSetting } from "../db/settings.js";
import { getAppByDomain } from "../db/apps.js";

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
  const trimmed = raw.trim().toLowerCase();
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

  const clash = getAppByDomain(trimmed);
  if (clash && clash.id !== appId) {
    return { ok: false, error: "conflict" };
  }

  return { ok: true, domain: trimmed };
}
