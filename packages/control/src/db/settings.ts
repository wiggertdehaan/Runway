import { db } from "./index.js";

/**
 * Simple key/value settings store. Used for platform-wide configuration
 * like the base wildcard domain, ACME email, etc.
 */

export type SettingKey =
  | "base_domain"
  | "acme_email"
  | "webhook_url"
  | "min_scan_threshold"
  | "max_upload_mb"
  | "oauth_google_client_id"
  | "oauth_google_client_secret"
  | "oauth_microsoft_client_id"
  | "oauth_microsoft_client_secret"
  | "activity_log_offset";

export function getSetting(key: SettingKey): string | undefined {
  const row = db.prepare(`SELECT value FROM settings WHERE key = ?`).get(key) as
    | { value: string }
    | undefined;
  return row?.value;
}

export function setSetting(key: SettingKey, value: string): void {
  db.prepare(
    `INSERT INTO settings (key, value, updated_at)
     VALUES (?, ?, datetime('now'))
     ON CONFLICT(key) DO UPDATE SET
       value = excluded.value,
       updated_at = datetime('now')`
  ).run(key, value);
}

export function deleteSetting(key: SettingKey): void {
  db.prepare(`DELETE FROM settings WHERE key = ?`).run(key);
}

/**
 * Default and ceiling for the deploy upload limit, in megabytes. The whole
 * tarball is buffered in memory during a deploy (`c.req.arrayBuffer()`), so
 * the ceiling guards against an admin setting a value that risks OOM on the
 * control container. Stored in the settings table as a plain integer.
 */
export const DEFAULT_MAX_UPLOAD_MB = 100;
export const MAX_UPLOAD_MB_CEILING = 2048;

/**
 * Resolve the configured deploy upload limit in bytes. Falls back to the
 * default when unset or unparseable, and clamps to
 * [1, MAX_UPLOAD_MB_CEILING] so a bad stored value can't break deploys.
 */
export function getMaxUploadBytes(): number {
  return getMaxUploadMb() * 1024 * 1024;
}

/** Same as getMaxUploadBytes() but in megabytes (for display in the UI). */
export function getMaxUploadMb(): number {
  return clampUploadMb(parseInt(getSetting("max_upload_mb") ?? "", 10));
}

/**
 * Clamp a parsed megabyte value to the valid range. Returns the default for
 * NaN/non-finite input, otherwise clamps to [1, MAX_UPLOAD_MB_CEILING].
 * Pure — used both when reading and when persisting the setting.
 */
export function clampUploadMb(parsed: number): number {
  if (!Number.isFinite(parsed)) return DEFAULT_MAX_UPLOAD_MB;
  return Math.min(Math.max(parsed, 1), MAX_UPLOAD_MB_CEILING);
}

/**
 * Normalize a user-provided base domain. Strips protocol, trailing slash,
 * and a leading wildcard if present. Returns undefined if invalid.
 */
export function normalizeBaseDomain(input: string): string | undefined {
  const trimmed = input
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, "")
    .replace(/\/+$/, "")
    .replace(/^\*\./, "");

  if (!trimmed) return undefined;
  // Must look like a domain: labels separated by dots, alphanumeric + hyphens
  if (!/^([a-z0-9]([a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}$/.test(trimmed)) {
    return undefined;
  }
  return trimmed;
}

/**
 * Convert a free-form app name into a URL-safe subdomain slug.
 */
export function slugify(name: string): string {
  return name
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 63);
}
