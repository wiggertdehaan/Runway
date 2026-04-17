import { Hono } from "hono";
import { apiAuth } from "../middleware/auth.js";
import {
  defaultPortForRuntime,
  isConfigured,
  RUNTIMES,
  updateApp,
  type App,
  type Runtime,
} from "../db/apps.js";
import { getSetting, slugify } from "../db/settings.js";
import {
  deployApp,
  getAppLogs,
  getAppStatus,
  rollbackApp,
} from "../deploy/index.js";
import { writeAppRoute } from "../deploy/gateway.js";
import { appContainerName } from "../deploy/index.js";
import { getEnvVars, setEnvVars, deleteEnvVar } from "../db/env.js";
import { getVolumes, setVolumes, deleteVolume } from "../db/volumes.js";

type Env = { Variables: { app: App } };

export const apiRoutes = new Hono<Env>();

// Max upload size for a project tarball (100 MB).
const MAX_UPLOAD_BYTES = 100 * 1024 * 1024;

apiRoutes.use("/*", apiAuth);

function toConfigResponse(app: App) {
  return {
    id: app.id,
    name: app.name,
    runtime: app.runtime,
    domain: app.domain,
    custom_domain: app.custom_domain,
    port: app.port,
    cpu_limit: app.cpu_limit,
    memory_limit: app.memory_limit,
    status: app.status,
    health_check_path: app.health_check_path,
    configured: isConfigured(app),
  };
}

// ── Config ───────────────────────────────────────────────
apiRoutes.get("/app", (c) => {
  const app = c.get("app");
  return c.json(toConfigResponse(app));
});

/**
 * Configure an unconfigured app (sets name + runtime + domain).
 * Called by the MCP server on first deploy when the caller has
 * only an API key and still needs to choose a name/runtime.
 */
apiRoutes.post("/app/configure", async (c) => {
  const app = c.get("app");
  const body = await c.req.json().catch(() => null);

  if (!body || typeof body !== "object") {
    return c.json({ error: "Invalid JSON body" }, 400);
  }

  const name = typeof body.name === "string" ? body.name.trim() : "";
  const runtime = typeof body.runtime === "string" ? body.runtime : "";

  if (!name) {
    return c.json({ error: "name is required" }, 400);
  }
  if (name.length > 64) {
    return c.json({ error: "name must be 64 characters or fewer" }, 400);
  }
  if (!RUNTIMES.includes(runtime as Runtime)) {
    return c.json(
      { error: `runtime must be one of: ${RUNTIMES.join(", ")}` },
      400
    );
  }

  const baseDomain = getSetting("base_domain");
  const slug = slugify(name);
  if (!slug) {
    return c.json({ error: "name must contain letters or digits" }, 400);
  }
  const domain = baseDomain ? `${slug}.${baseDomain}` : null;
  const port = defaultPortForRuntime(runtime as Runtime);

  const updated = updateApp(app.id, {
    name,
    runtime: runtime as Runtime,
    domain,
    port,
  });
  if (!updated) {
    return c.json({ error: "App not found" }, 404);
  }

  return c.json(toConfigResponse(updated));
});

// ── Deploy ───────────────────────────────────────────────
apiRoutes.post("/app/preflight", (c) => {
  const app = c.get("app");
  return c.json({ app_id: app.id, checks: [], status: "passed" });
});

/**
 * Deploy accepts a tar stream (no gzip) of the project root as the
 * raw request body. Content-Type must be application/x-tar. The body
 * is forwarded straight to the Docker build API, so whatever layout
 * the caller uses is whatever `docker build` sees.
 */
apiRoutes.post("/app/deploy", async (c) => {
  const app = c.get("app");

  if (!isConfigured(app)) {
    return c.json(
      { error: "App is not configured yet. Call /app/configure first." },
      409
    );
  }

  const contentType = c.req.header("content-type") || "";
  if (!contentType.startsWith("application/x-tar")) {
    return c.json(
      { error: "Expected Content-Type: application/x-tar" },
      415
    );
  }

  const lengthHeader = c.req.header("content-length");
  if (lengthHeader && parseInt(lengthHeader, 10) > MAX_UPLOAD_BYTES) {
    return c.json(
      { error: `Upload exceeds limit of ${MAX_UPLOAD_BYTES} bytes` },
      413
    );
  }

  const arrayBuffer = await c.req.arrayBuffer();
  if (arrayBuffer.byteLength > MAX_UPLOAD_BYTES) {
    return c.json(
      { error: `Upload exceeds limit of ${MAX_UPLOAD_BYTES} bytes` },
      413
    );
  }
  if (arrayBuffer.byteLength === 0) {
    return c.json({ error: "Empty upload" }, 400);
  }

  const tarBuffer = Buffer.from(arrayBuffer);

  try {
    const result = await deployApp({ app, tar: tarBuffer });
    return c.json({
      status: "deployed",
      ...result,
      note: result.domain
        ? `TLS certificate is issued on first request and may take 5-15 seconds. Use /app/status to verify without TLS.`
        : undefined,
    });
  } catch (err: any) {
    updateApp(app.id, { status: "failed" });
    return c.json(
      {
        status: "failed",
        error: err?.message ?? "Deploy failed",
        log_tail:
          typeof err?.log === "string"
            ? err.log.split("\n").slice(-20).join("\n")
            : undefined,
      },
      500
    );
  }
});

apiRoutes.get("/app/status", async (c) => {
  const app = c.get("app");
  try {
    const status = await getAppStatus(app);
    return c.json(status);
  } catch (err: any) {
    return c.json({ error: err?.message ?? "Status check failed" }, 500);
  }
});

apiRoutes.get("/app/logs", async (c) => {
  const app = c.get("app");
  const tailParam = c.req.query("tail");
  const tail = tailParam ? parseInt(tailParam, 10) : 200;
  try {
    const logs = await getAppLogs(app, Number.isNaN(tail) ? 200 : tail);
    return c.json(logs);
  } catch (err: any) {
    return c.json({ error: err?.message ?? "Log fetch failed" }, 500);
  }
});

// ── Environment variables ───────────────────────────────
apiRoutes.get("/app/env", (c) => {
  const app = c.get("app");
  return c.json({ app_id: app.id, env: getEnvVars(app.id) });
});

apiRoutes.put("/app/env", async (c) => {
  const app = c.get("app");
  const body = await c.req.json().catch(() => null);

  if (!body || typeof body !== "object" || typeof body.env !== "object") {
    return c.json({ error: 'Expected JSON body with "env" object' }, 400);
  }

  const env = body.env as Record<string, unknown>;
  const clean: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (typeof key !== "string" || !key.match(/^[A-Za-z_][A-Za-z0-9_]*$/)) {
      return c.json(
        { error: `Invalid env var name: ${key}` },
        400
      );
    }
    clean[key] = String(value);
  }

  setEnvVars(app.id, clean);
  return c.json({ app_id: app.id, env: getEnvVars(app.id) });
});

apiRoutes.delete("/app/env/:key", (c) => {
  const app = c.get("app");
  const key = c.req.param("key");
  const deleted = deleteEnvVar(app.id, key);
  if (!deleted) {
    return c.json({ error: `Env var '${key}' not found` }, 404);
  }
  return c.json({ app_id: app.id, deleted: key });
});

// ── Volumes ─────────────────────────────────────────────
apiRoutes.get("/app/volumes", (c) => {
  const app = c.get("app");
  return c.json({ app_id: app.id, volumes: getVolumes(app.id) });
});

apiRoutes.put("/app/volumes", async (c) => {
  const app = c.get("app");
  const body = await c.req.json().catch(() => null);

  if (!body || !Array.isArray(body.mount_paths)) {
    return c.json(
      { error: 'Expected JSON body with "mount_paths" array of absolute paths' },
      400
    );
  }

  for (const p of body.mount_paths) {
    if (
      typeof p !== "string" ||
      !p.startsWith("/") ||
      p === "/" ||
      p.includes("..") ||
      !/^\/[a-zA-Z0-9._\-/]+$/.test(p)
    ) {
      return c.json(
        {
          error: `Invalid mount path: ${p}. Must be an absolute path without traversal.`,
        },
        400
      );
    }
  }

  setVolumes(app.id, body.mount_paths);
  return c.json({ app_id: app.id, volumes: getVolumes(app.id) });
});

apiRoutes.delete("/app/volumes/:path{.+}", (c) => {
  const app = c.get("app");
  const mountPath = "/" + c.req.param("path");
  const deleted = deleteVolume(app.id, mountPath);
  if (!deleted) {
    return c.json({ error: `Volume '${mountPath}' not found` }, 404);
  }
  return c.json({ app_id: app.id, deleted: mountPath });
});

// ── Custom domain ───────────────────────────────────────
apiRoutes.put("/app/domain", async (c) => {
  const app = c.get("app");
  const body = await c.req.json().catch(() => null);

  if (!body || typeof body !== "object") {
    return c.json({ error: "Invalid JSON body" }, 400);
  }

  const customDomain =
    typeof body.custom_domain === "string"
      ? body.custom_domain.trim().toLowerCase()
      : null;

  if (customDomain && !/^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$/.test(customDomain)) {
    return c.json({ error: "Invalid domain name" }, 400);
  }

  const updated = updateApp(app.id, {
    custom_domain: customDomain || null,
  });
  if (!updated) return c.json({ error: "App not found" }, 404);

  if (updated.domain) {
    await writeAppRoute({
      appId: updated.id,
      containerName: appContainerName(updated.id),
      domain: updated.domain,
      customDomain: updated.custom_domain,
      port: updated.port,
    });
  }

  return c.json(toConfigResponse(updated));
});

// ── Health check ────────────────────────────────────────
apiRoutes.put("/app/healthcheck", async (c) => {
  const app = c.get("app");
  const body = await c.req.json().catch(() => null);

  if (!body || typeof body !== "object") {
    return c.json({ error: "Invalid JSON body" }, 400);
  }

  const path =
    typeof body.path === "string" ? body.path.trim() : null;

  if (path && !/^\/[a-zA-Z0-9._\-/?=&%]*$/.test(path)) {
    return c.json(
      { error: "Health check path must start with / and contain only URL-safe characters" },
      400
    );
  }

  const updated = updateApp(app.id, {
    health_check_path: path || null,
  });
  if (!updated) return c.json({ error: "App not found" }, 404);

  return c.json(toConfigResponse(updated));
});

// ── Rollback ────────────────────────────────────────────
apiRoutes.post("/app/rollback", async (c) => {
  const app = c.get("app");

  if (!isConfigured(app)) {
    return c.json({ error: "App is not configured yet." }, 409);
  }

  try {
    const result = await rollbackApp(app);
    return c.json({ status: "rolled_back", ...result });
  } catch (err: any) {
    return c.json({ error: err?.message ?? "Rollback failed" }, 500);
  }
});
