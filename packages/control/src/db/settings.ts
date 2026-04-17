import { db } from "./index.js";

/**
 * Simple key/value settings store. Used for platform-wide configuration
 * like the base wildcard domain, ACME email, etc.
 */

export type SettingKey = "base_domain" | "acme_email";

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
