import type { SQLInputValue } from "node:sqlite";
import { customAlphabet, nanoid } from "nanoid";
import { db } from "./index.js";
import { normalizeHost } from "./domain-index.js";

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
  api_key: string;
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
  created_by: string | null;
  scan_threshold: string;
  scan_floor_exempt: number;
  sso_enabled: number;
  auto_rebuild: number;
  auto_patch_base: number;
  auto_minor_base: number;
  auto_update_deps: number;
  auto_update_deps_major: number;
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
 */
export function createApp(createdBy?: string): App {
  const id = generateAppId();
  const api_key = `rwy_${nanoid(32)}`;

  db.prepare(
    `INSERT INTO apps (id, api_key, name, runtime, created_by) VALUES (?, ?, NULL, NULL, ?)`
  ).run(id, api_key, createdBy ?? null);

  return getApp(id)!;
}

export function getApp(id: string): App | undefined {
  return db.prepare(`SELECT * FROM apps WHERE id = ?`).get(id) as
    | unknown as App | undefined;
}

export function getAppByKey(api_key: string): App | undefined {
  return db
    .prepare(`SELECT * FROM apps WHERE api_key = ?`)
    .get(api_key) as unknown as App | undefined;
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

export function listApps(): App[] {
  return db
    .prepare(`SELECT * FROM apps ORDER BY created_at DESC`)
    .all() as unknown as App[];
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

export function deleteApp(id: string): boolean {
  const result = db.prepare(`DELETE FROM apps WHERE id = ?`).run(id);
  return result.changes > 0;
}
