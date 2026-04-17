import { mkdir, writeFile, unlink } from "node:fs/promises";
import { createHash } from "node:crypto";
import { join } from "node:path";
import yaml from "js-yaml";
import type { App } from "../db/apps.js";

const GATEWAY_CONFIG_DIR =
  process.env.GATEWAY_CONFIG_DIR || "/gateway-config";

/**
 * Write the static dashboard route into the shared gateway config
 * directory. Called at control startup so Traefik finds the route
 * as soon as the volume is populated. Idempotent.
 */
export async function writeDashboardRoute(domain: string): Promise<void> {
  await mkdir(GATEWAY_CONFIG_DIR, { recursive: true });

  const doc = {
    http: {
      routers: {
        control: {
          rule: `Host(\`${domain}\`)`,
          entryPoints: ["websecure"],
          service: "control",
          tls: { certResolver: "letsencrypt" },
        },
      },
      services: {
        control: {
          loadBalancer: {
            servers: [{ url: "http://control:3000" }],
          },
        },
      },
    },
  };

  const path = join(GATEWAY_CONFIG_DIR, "dashboard.yml");
  await writeFile(path, yaml.dump(doc), "utf8");
}

export interface AppRouteConfig {
  appId: string;
  containerName: string;
  domain: string;
  customDomain?: string | null;
  port: number;
  basicAuth?: { htpasswd: string } | null;
}

/**
 * Build a Traefik-compatible htpasswd line for a single user. Uses
 * `{SHA}` format: supported by Traefik natively and derivable with
 * only node:crypto. The gateway-config volume is only readable by
 * root on the host, so an offline attack on the hash requires host
 * compromise — in which case the attacker already has the app DB.
 */
export function buildHtpasswd(username: string, password: string): string {
  const digest = createHash("sha1").update(password).digest("base64");
  return `${username}:{SHA}${digest}`;
}

/**
 * Read the basicAuth block for an app from the DB record, or null if
 * disabled or not configured. Keeps gateway call sites from having to
 * know about column names.
 */
export function appBasicAuth(app: App): { htpasswd: string } | null {
  if (!app.basic_auth_enabled || !app.basic_auth_htpasswd) return null;
  return { htpasswd: app.basic_auth_htpasswd };
}

/**
 * Write a Traefik dynamic config file for a single app. Traefik
 * watches the shared config directory and picks up new files
 * without requiring a reload.
 */
export async function writeAppRoute(cfg: AppRouteConfig): Promise<void> {
  await mkdir(GATEWAY_CONFIG_DIR, { recursive: true });

  const routerKey = `app-${cfg.appId}`;
  const domains = [cfg.domain];
  if (cfg.customDomain) domains.push(cfg.customDomain);
  const hostRule = domains.map((d) => `Host(\`${d}\`)`).join(" || ");

  const middlewareKey = `${routerKey}-basicauth`;
  const useBasicAuth = !!cfg.basicAuth?.htpasswd;

  const router: Record<string, unknown> = {
    rule: hostRule,
    entryPoints: ["websecure"],
    service: routerKey,
    tls: {
      certResolver: "letsencrypt",
      ...(cfg.customDomain
        ? {
            domains: domains.map((d) => ({ main: d })),
          }
        : {}),
    },
  };
  if (useBasicAuth) router.middlewares = [middlewareKey];

  const doc: Record<string, unknown> = {
    http: {
      routers: {
        [routerKey]: router,
      },
      services: {
        [routerKey]: {
          loadBalancer: {
            servers: [{ url: `http://${cfg.containerName}:${cfg.port}` }],
          },
        },
      },
      ...(useBasicAuth
        ? {
            middlewares: {
              [middlewareKey]: {
                basicAuth: {
                  users: [cfg.basicAuth!.htpasswd],
                },
              },
            },
          }
        : {}),
    },
  };

  const path = join(GATEWAY_CONFIG_DIR, `${cfg.appId}.yml`);
  await writeFile(path, yaml.dump(doc), "utf8");
}

export async function deleteAppRoute(appId: string): Promise<void> {
  const path = join(GATEWAY_CONFIG_DIR, `${appId}.yml`);
  try {
    await unlink(path);
  } catch (err: any) {
    if (err.code !== "ENOENT") throw err;
  }
}
