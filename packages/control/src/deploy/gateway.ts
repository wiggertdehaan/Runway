import { mkdir, writeFile, unlink } from "node:fs/promises";
import { join } from "node:path";
import yaml from "js-yaml";

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
  port: number;
}

/**
 * Write a Traefik dynamic config file for a single app. Traefik
 * watches the shared config directory and picks up new files
 * without requiring a reload.
 */
export async function writeAppRoute(cfg: AppRouteConfig): Promise<void> {
  await mkdir(GATEWAY_CONFIG_DIR, { recursive: true });

  const routerKey = `app-${cfg.appId}`;
  const doc = {
    http: {
      routers: {
        [routerKey]: {
          rule: `Host(\`${cfg.domain}\`)`,
          entryPoints: ["websecure"],
          service: routerKey,
          tls: {
            certResolver: "letsencrypt",
          },
        },
      },
      services: {
        [routerKey]: {
          loadBalancer: {
            servers: [{ url: `http://${cfg.containerName}:${cfg.port}` }],
          },
        },
      },
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
