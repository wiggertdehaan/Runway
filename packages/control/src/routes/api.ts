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
import { deployApp, getAppLogs, getAppStatus } from "../deploy/index.js";

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
    port: app.port,
    cpu_limit: app.cpu_limit,
    memory_limit: app.memory_limit,
    status: app.status,
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
    return c.json({ status: "deployed", ...result });
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
