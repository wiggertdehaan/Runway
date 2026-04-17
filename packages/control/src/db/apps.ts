import type { SQLInputValue } from "node:sqlite";
import { customAlphabet, nanoid } from "nanoid";
import { db } from "./index.js";

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
export function createApp(): App {
  const id = generateAppId();
  const api_key = `rwy_${nanoid(32)}`;

  db.prepare(
    `INSERT INTO apps (id, api_key, name, runtime) VALUES (?, ?, NULL, NULL)`
  ).run(id, api_key);

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
