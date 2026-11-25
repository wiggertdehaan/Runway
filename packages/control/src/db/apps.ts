import type { SQLInputValue } from "node:sqlite";
import { customAlphabet, nanoid } from "nanoid";
import { db } from "./index.js";
import { normalizeHost } from "./domain-index.js";
import {
  hashToken,
  newToken,
  placeholderFor,
  safeEqualHex,
  tokenHint,
} from "../util/token-hash.js";

// Lowercase alphabet for app ids so they round-trip cleanly into
// Docker image and container names (which must be lowercase).
const appIdAlphabet = "0123456789abcdefghijklmnopqrstuvwxyz";
const generateAppId = customAlphabet(appIdAlphabet, 12);

export type Runtime = "node" | "python" | "go" | "static";

export const RUNTIMES: Runtime[] = ["node", "python", "go", "static"];

/**
 * Default TCP port a container exposes for a given runtime. Used by
 * the control plane to wire up Traefik routes. Static sites are
 * served by nginx (port 80); everything else we template ourselves
 * listens on 3000 by convention.
 */
export function defaultPortForRuntime(runtime: Runtime): number {
  return runtime === "static" ? 80 : 3000;
}

export interface App {
  id: string;
  name: string | null;
  /**
   * NOT the key. Keys are stored as hashes (S10); this column holds the
   * non-secret placeholder `hashed:<id>`. The plaintext exists only on the
   * object `createApp` and `rotateAppKey` hand back, once.
   */
  api_key: string;
  api_key_hash: string | null;
  /** Last four characters of the key, so two keys can be told apart in a list. */
  api_key_hint: string | null;
  /** Hash of the key a rotation replaced, valid until `prev_key_expires_at`. */
  prev_key_hash: string | null;
  prev_key_expires_at: string | null;
  runtime: Runtime | null;
  port: number;
  domain: string | null;
  custom_domain: string | null;
  cpu_limit: string;
  memory_limit: string;
  status: string;
  health_check_path: string | null;
  image_tag: string | null;
  container_id: string | null;
  /** Historical label (the creator's username at the time). Never used for rights. */
  created_by: string | null;
  /** Who owns the app. NULL = no owner: admin-only. The only field rights are checked on. */
  owner_user_id: string | null;
  scan_threshold: string;
  scan_floor_exempt: number;
  sso_enabled: number;
  auto_rebuild: number;
  auto_patch_base: number;
  auto_minor_base: number;
  auto_update_deps: number;
  auto_update_deps_major: number;
  /** Administrator's hardening profile for this app; NULL = instance default. */
  hardening_profile: string | null;
  readonly_rootfs: number;
  /** Plain text, at most 400 characters (util/description.ts). NULL = none. */
  description: string | null;
  /** ISO time a person stopped the app; null when it is not stopped by a person. */
  stopped_at: string | null;
  /** ISO time the app was moved to the trash; null = a normal app. */
  deleted_at: string | null;
  basic_auth_enabled: number;
  basic_auth_username: string | null;
  basic_auth_htpasswd: string | null;
  last_request_at: string | null;
  created_at: string;
  updated_at: string;
}

export function isConfigured(app: App): boolean {
  return !!(app.name && app.runtime);
}

/**
 * Create a fresh app. Only an API key is generated here; name, runtime,
 * and domain are set later via the MCP configure flow.
 *
 * `owner` is the user the app belongs to; routes pass the signed-in user.
 * A bare username string is resolved to that account once, right now, and
 * never kept as the owner (S13: a name is not an identity). A string that
 * matches no account gives an app without an owner.
 */
export function createApp(owner?: { id: string; username: string } | string): App {
  const id = generateAppId();
  const api_key = newToken("app-key");
  const ref =
    typeof owner === "string"
      ? (db.prepare(`SELECT id, username FROM users WHERE username = ?`).get(owner) as
          | { id: string; username: string }
          | undefined) ?? null
      : owner ?? null;

  // S10: only the hash is stored. The plaintext leaves this function once, on
  // the returned object, for the caller to show to the person who asked.
  db.prepare(
    `INSERT INTO apps (id, api_key, api_key_hash, api_key_hint, name, runtime, created_by, owner_user_id)
     VALUES (?, ?, ?, ?, NULL, NULL, ?, ?)`
  ).run(
    id,
    placeholderFor(id),
    hashToken(api_key),
    tokenHint(api_key),
    ref?.username ?? (typeof owner === "string" ? owner : null),
    ref?.id ?? null
  );

  return { ...getApp(id)!, api_key };
}

export function getApp(id: string): App | undefined {
  return db.prepare(`SELECT * FROM apps WHERE id = ?`).get(id) as
    | unknown as App | undefined;
}

/**
 * The app a presented key belongs to: its current key, or (for a short while
 * after a rotation that asked for an overlap) the key it replaced.
 * Lookup is by hash; the match is then confirmed in constant time.
 */
export function getAppByKey(presented: string, now = Date.now()): App | undefined {
  const hash = hashToken(presented);
  const current = db
    .prepare(`SELECT * FROM apps WHERE api_key_hash = ?`)
    .get(hash) as unknown as App | undefined;
  if (current && current.api_key_hash && safeEqualHex(current.api_key_hash, hash)) {
    return current;
  }

  const previous = db
    .prepare(`SELECT * FROM apps WHERE prev_key_hash = ?`)
    .get(hash) as unknown as App | undefined;
  if (
    previous &&
    previous.prev_key_hash &&
    previous.prev_key_expires_at &&
    safeEqualHex(previous.prev_key_hash, hash) &&
    Date.parse(previous.prev_key_expires_at.replace(" ", "T") + "Z") > now
  ) {
    return previous;
  }

  // A row written by something that does not know about hashes yet (an old
  // process during a rolling upgrade, a restore of an old backup) still has
  // its plaintext key and no hash. Take it over on first use.
  const legacy = db
    .prepare(`SELECT * FROM apps WHERE api_key_hash IS NULL AND api_key = ?`)
    .get(presented) as unknown as App | undefined;
  if (legacy) {
    db.prepare(
      `UPDATE apps SET api_key_hash = ?, api_key_hint = ?, api_key = ? WHERE id = ? AND api_key_hash IS NULL`
    ).run(hash, tokenHint(presented), placeholderFor(legacy.id), legacy.id);
    return getApp(legacy.id);
  }
  return undefined;
}

/**
 * S11: replace an app's key. With `graceMinutes` > 0 the old key keeps working
 * for that long (so a pipeline can be updated without a gap); with 0 it stops
 * at once. Rotating again while an overlap is running ends the older overlap:
 * there is never more than one extra key. Returns the new key, once.
 */
export function rotateAppKey(
  appId: string,
  graceMinutes = 0,
  now = Date.now()
): { app: App; key: string } | null {
  const existing = getApp(appId);
  if (!existing) return null;
  const key = newToken("app-key");
  const grace = Math.max(0, Math.min(Math.floor(graceMinutes), MAX_KEY_GRACE_MINUTES));
  const prevHash = grace > 0 ? existing.api_key_hash : null;
  const prevExpires =
    grace > 0 ? new Date(now + grace * 60_000).toISOString().slice(0, 19).replace("T", " ") : null;
  db.prepare(
    `UPDATE apps
        SET api_key_hash = ?, api_key_hint = ?, api_key = ?,
            prev_key_hash = ?, prev_key_expires_at = ?, updated_at = datetime('now')
      WHERE id = ?`
  ).run(hashToken(key), tokenHint(key), placeholderFor(appId), prevHash, prevExpires, appId);
  return { app: { ...getApp(appId)!, api_key: key }, key };
}

/** End an overlap early: the replaced key stops working now. */
export function revokePreviousKey(appId: string): boolean {
  return (
    db
      .prepare(
        `UPDATE apps SET prev_key_hash = NULL, prev_key_expires_at = NULL WHERE id = ? AND prev_key_hash IS NOT NULL`
      )
      .run(appId).changes > 0
  );
}

/** Longest overlap a rotation may ask for: one week. */
export const MAX_KEY_GRACE_MINUTES = 7 * 24 * 60;

/** Is an overlap still running for this app? */
export function previousKeyActive(
  app: Pick<App, "prev_key_hash" | "prev_key_expires_at">,
  now = Date.now()
): boolean {
  return (
    !!app.prev_key_hash &&
    !!app.prev_key_expires_at &&
    Date.parse(app.prev_key_expires_at.replace(" ", "T") + "Z") > now
  );
}

/**
 * The app answering to a hostname. Hostnames are case-insensitive and a
 * trailing dot is the same name. With the uniqueness rules there is at most
 * one; the ORDER BY only matters on an installation that still holds
 * duplicates from before S03, where the oldest app (the original owner of
 * the name) wins deterministically instead of whichever row SQLite returns.
 */
export function getAppByDomain(domain: string): App | undefined {
  const host = normalizeHost(domain);
  return db
    .prepare(
      `SELECT * FROM apps WHERE lower(domain) = ? OR lower(custom_domain) = ?
       ORDER BY created_at ASC, id ASC LIMIT 1`
    )
    .get(host, host) as unknown as App | undefined;
}

/** Is this hostname already used by an app other than `exceptAppId`? */
export function isDomainTaken(domain: string, exceptAppId: string): boolean {
  const host = normalizeHost(domain);
  const row = db
    .prepare(
      `SELECT 1 AS taken FROM apps
        WHERE id != ? AND (lower(domain) = ? OR lower(custom_domain) = ?) LIMIT 1`
    )
    .get(exceptAppId, host, host);
  return !!row;
}

/** Does this user own the app? An app without an owner is nobody's. */
export function isAppOwner(
  user: { id: string },
  app: { owner_user_id: string | null }
): boolean {
  return app.owner_user_id !== null && app.owner_user_id === user.id;
}

/**
 * Give an app to a user, or (userId = null) to nobody: an ownerless app is
 * admin-only. Rights follow `owner_user_id`, so this is the one place that
 * moves them. Refuses a user id that does not exist (a dangling owner would
 * be an app nobody could ever see). Returns the previous owner id so the
 * caller can audit the move.
 */
export function setAppOwner(
  appId: string,
  userId: string | null
): { ok: true; previous: string | null } | { ok: false } {
  const app = getApp(appId);
  if (!app) return { ok: false };
  if (userId !== null) {
    const exists = db.prepare(`SELECT 1 AS ok FROM users WHERE id = ?`).get(userId);
    if (!exists) return { ok: false };
  }
  db.prepare(`UPDATE apps SET owner_user_id = ?, updated_at = datetime('now') WHERE id = ?`).run(
    userId,
    appId
  );
  return { ok: true, previous: app.owner_user_id };
}

/** Current username of an app's owner, for display only; null when it has none. */
export function ownerUsernameOf(app: { owner_user_id: string | null }): string | null {
  if (!app.owner_user_id) return null;
  const row = db
    .prepare(`SELECT username FROM users WHERE id = ?`)
    .get(app.owner_user_id) as { username: string } | undefined;
  return row?.username ?? null;
}

/**
 * May this person see (and, as owner or admin, manage) this app? The one rule
 * behind the dashboard's app list and the API's user tokens: an admin sees all
 * apps, an owner their own (by user id), nobody else's, and an app without an
 * owner is admin-only.
 */
export function appVisibleTo(
  user: { id: string; role: string },
  app: { owner_user_id: string | null }
): boolean {
  return user.role === "admin" || isAppOwner(user, app);
}

/** The apps this viewer may see: all for an admin, their own for an owner. */
export function appsVisibleTo(userId: string, admin: boolean): App[] {
  const user = { id: userId, role: admin ? "admin" : "member" };
  return listApps().filter((a) => appVisibleTo(user, a));
}

/**
 * The apps that are in use: everything except the trash. Every job and page
 * that works on "the apps" (rebuild, scans, health, quarantine, lists, rights)
 * goes through this, so a trashed app is invisible to all of them at once.
 */
export function listApps(): App[] {
  return db
    .prepare(`SELECT * FROM apps WHERE deleted_at IS NULL ORDER BY created_at DESC`)
    .all() as unknown as App[];
}

/** Every app including the trash: for the purge job and for resource cleanup. */
export function listAllApps(): App[] {
  return db
    .prepare(`SELECT * FROM apps ORDER BY created_at DESC`)
    .all() as unknown as App[];
}

/** The trash, newest first. */
export function listDeletedApps(): App[] {
  return db
    .prepare(`SELECT * FROM apps WHERE deleted_at IS NOT NULL ORDER BY deleted_at DESC`)
    .all() as unknown as App[];
}

/** The trashed apps this viewer may see (an admin all, an owner their own). */
export function deletedAppsVisibleTo(userId: string, admin: boolean): App[] {
  const user = { id: userId, role: admin ? "admin" : "member" };
  return listDeletedApps().filter((a) => appVisibleTo(user, a));
}

type UpdatableAppFields = Partial<
  Pick<
    App,
    | "name"
    | "runtime"
    | "port"
    | "domain"
    | "custom_domain"
    | "cpu_limit"
    | "memory_limit"
    | "status"
    | "health_check_path"
    | "image_tag"
    | "container_id"
    | "scan_threshold"
    | "scan_floor_exempt"
    | "sso_enabled"
    | "auto_rebuild"
    | "auto_patch_base"
    | "auto_minor_base"
    | "auto_update_deps"
    | "auto_update_deps_major"
    | "hardening_profile"
    | "readonly_rootfs"
    | "description"
    | "stopped_at"
    | "deleted_at"
    | "basic_auth_enabled"
    | "basic_auth_username"
    | "basic_auth_htpasswd"
  >
>;

export function updateApp(
  id: string,
  fields: UpdatableAppFields
): App | undefined {
  const sets: string[] = [];
  const values: SQLInputValue[] = [];

  for (const [key, value] of Object.entries(fields)) {
    sets.push(`${key} = ?`);
    values.push(value as SQLInputValue);
  }

  if (sets.length === 0) return getApp(id);

  sets.push(`updated_at = datetime('now')`);
  values.push(id);

  db.prepare(`UPDATE apps SET ${sets.join(", ")} WHERE id = ?`).run(...values);

  return getApp(id);
}

/**
 * Fill the description from a README, but only while it is empty. One
 * statement, so a description somebody sets while a deploy is running is never
 * overwritten by it. Returns whether it was written.
 */
export function setDescriptionIfEmpty(id: string, text: string): boolean {
  const r = db
    .prepare(
      `UPDATE apps SET description = ?, updated_at = datetime('now')
       WHERE id = ? AND (description IS NULL OR TRIM(description) = '')`
    )
    .run(text, id);
  return r.changes > 0;
}

export function deleteApp(id: string): boolean {
  const result = db.prepare(`DELETE FROM apps WHERE id = ?`).run(id);
  return result.changes > 0;
}
