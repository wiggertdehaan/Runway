import { mkdir, writeFile, unlink } from "node:fs/promises";
import { join } from "node:path";
import yaml from "js-yaml";
import bcrypt from "bcryptjs";
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
  ssoEnabled?: boolean;
}

/**
 * Build a Traefik-compatible htpasswd line for a single user using
 * bcrypt, which is a slow password hashing scheme suitable for
 * password storage.
 */
export function buildHtpasswd(username: string, password: string): string {
  const hash = bcrypt.hashSync(password, 12);
  return `${username}:${hash}`;
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
 * Build the Traefik dynamic config document for a single app. Split
 * out from writeAppRoute so the routing rules can be asserted without
 * touching the filesystem - the matchers below are easy to get subtly
 * wrong and impossible to eyeball.
 */
export function buildAppRouteDoc(cfg: AppRouteConfig): Record<string, unknown> {
  const routerKey = `app-${cfg.appId}`;
  const useBasicAuth = !cfg.ssoEnabled && !!cfg.basicAuth?.htpasswd;
  const useSso = !!cfg.ssoEnabled;

  const basicAuthKey = `${routerKey}-basicauth`;
  const forwardAuthKey = `${routerKey}-forwardauth`;

  const middlewares: Record<string, unknown> = {};
  if (useBasicAuth) {
    middlewares[basicAuthKey] = {
      basicAuth: { users: [cfg.basicAuth!.htpasswd] },
    };
  }
  if (useSso) {
    middlewares[forwardAuthKey] = {
      forwardAuth: {
        address: "http://control:3000/auth/verify",
        trustForwardHeader: true,
        authResponseHeaders: ["X-Forwarded-User"],
      },
    };
  }

  const routerMiddlewares: string[] = [];
  if (useSso) routerMiddlewares.push(forwardAuthKey);
  else if (useBasicAuth) routerMiddlewares.push(basicAuthKey);

  const routers: Record<string, unknown> = {};
  const allDomains = [cfg.domain];
  if (cfg.customDomain) allDomains.push(cfg.customDomain);

  if (useSso && cfg.customDomain) {
    // SSO only works on subdomains (session cookie scope). Split
    // into two routers: subdomain with forwardAuth, custom domain
    // without.
    routers[routerKey] = {
      rule: `Host(\`${cfg.domain}\`)`,
      entryPoints: ["websecure"],
      service: routerKey,
      tls: { certResolver: "letsencrypt" },
      middlewares: [forwardAuthKey],
    };
    routers[`${routerKey}-custom`] = {
      rule: `Host(\`${cfg.customDomain}\`)`,
      entryPoints: ["websecure"],
      service: routerKey,
      tls: {
        certResolver: "letsencrypt",
        domains: allDomains.map((d) => ({ main: d })),
      },
    };
  } else {
    const hostRule = allDomains
      .map((d) => `Host(\`${d}\`)`)
      .join(" || ");
    const router: Record<string, unknown> = {
      rule: hostRule,
      entryPoints: ["websecure"],
      service: routerKey,
      tls: {
        certResolver: "letsencrypt",
        ...(cfg.customDomain
          ? { domains: allDomains.map((d) => ({ main: d })) }
          : {}),
      },
    };
    if (routerMiddlewares.length > 0) {
      router.middlewares = routerMiddlewares;
    }
    routers[routerKey] = router;
  }

  // Build metadata must never be served by an app container. The static
  // preset copies the whole build context into the nginx webroot, so any
  // repo without a strict .dockerignore leaks its Dockerfile, README and
  // dotfiles (including .github/ and .env). Blocking at the gateway makes
  // the guarantee hold for every app regardless of what its image holds,
  // and survives redeploys. Traefik has no native deny middleware; an
  // ipAllowList whose range matches no source address returns 403.
  // Note: the matchers are Go RE2 - no lookahead - so .well-known is
  // carved out with Traefik's ! operator instead, otherwise ACME
  // HTTP-01 renewal would break for every app.
  const denyKey = `${routerKey}-denyall`;
  middlewares[denyKey] = {
    ipAllowList: { sourceRange: ["255.255.255.255/32"] },
  };
  routers[`${routerKey}-blockmeta`] = {
    rule:
      `(${allDomains.map((d) => `Host(\`${d}\`)`).join(" || ")})` +
      " && !PathPrefix(`/.well-known/`)" +
      " && (PathRegexp(`(^|/)Dockerfile$`)" +
      " || PathRegexp(`/[.]`)" +
      " || PathRegexp(`(^|/)(README|CLAUDE|AGENTS|HISTORY)[.]md$`))",
    priority: 100000,
    entryPoints: ["websecure"],
    service: routerKey,
    tls: { certResolver: "letsencrypt" },
    middlewares: [denyKey],
  };

  const doc: Record<string, unknown> = {
    http: {
      routers,
      services: {
        [routerKey]: {
          loadBalancer: {
            servers: [{ url: `http://${cfg.containerName}:${cfg.port}` }],
          },
        },
      },
      ...(Object.keys(middlewares).length > 0 ? { middlewares } : {}),
    },
  };

  return doc;
}

/**
 * Write a Traefik dynamic config file for a single app. Traefik
 * watches the shared config directory and picks up new files
 * without requiring a reload.
 */
export async function writeAppRoute(cfg: AppRouteConfig): Promise<void> {
  await mkdir(GATEWAY_CONFIG_DIR, { recursive: true });
  const path = join(GATEWAY_CONFIG_DIR, `${cfg.appId}.yml`);
  await writeFile(path, yaml.dump(buildAppRouteDoc(cfg)), "utf8");
}

export async function deleteAppRoute(appId: string): Promise<void> {
  const path = join(GATEWAY_CONFIG_DIR, `${appId}.yml`);
  try {
    await unlink(path);
  } catch (err: any) {
    if (err.code !== "ENOENT") throw err;
  }
}
