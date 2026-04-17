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
  ScanBlockedError,
} from "../deploy/index.js";
import { THRESHOLDS, isValidThreshold, effectiveThreshold, type Threshold } from "../deploy/scan.js";
import { getDeploy, getLatestDeployWithScan, getLatestDeploys } from "../db/deploys.js";
import { appBasicAuth, buildHtpasswd, writeAppRoute } from "../deploy/gateway.js";
import { appContainerName } from "../deploy/index.js";
import { getEnvVars, setEnvVars, deleteEnvVar } from "../db/env.js";
import { notifyDeployFailure } from "../util/webhook.js";
import { getVolumes, setVolumes, deleteVolume } from "../db/volumes.js";
import { getAppAllowedEmails, setAppAllowedEmails } from "../db/app-emails.js";

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
    scan_threshold: app.scan_threshold,
    scan_floor_exempt: !!app.scan_floor_exempt,
    effective_scan_threshold: effectiveThreshold(
      (app.scan_threshold ?? "none") as Threshold,
      (getSetting("min_scan_threshold") ?? "none") as Threshold,
      !!app.scan_floor_exempt
    ),
    basic_auth: {
      enabled: !!app.basic_auth_enabled,
      username: app.basic_auth_username,
    },
    sso_enabled: !!app.sso_enabled,
    configured: isConfigured(app),
  };
}

// Keep the deploy response bounded: truncate the findings list so large
// scans don't balloon the JSON body. The full report is available via
// the scan detail endpoint.
const MAX_FINDINGS_IN_DEPLOY_RESPONSE = 25;

function summarizeScanForResponse<T extends { findings: unknown[] }>(scan: T) {
  return {
    ...scan,
    findings: scan.findings.slice(0, MAX_FINDINGS_IN_DEPLOY_RESPONSE),
    truncated: scan.findings.length > MAX_FINDINGS_IN_DEPLOY_RESPONSE,
    total_findings: scan.findings.length,
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

  const patch: Parameters<typeof updateApp>[1] = {
    name,
    runtime: runtime as Runtime,
    domain,
    port,
  };

  if (body.scan_threshold !== undefined) {
    if (!isValidThreshold(body.scan_threshold)) {
      return c.json(
        {
          error: `scan_threshold must be one of: ${THRESHOLDS.join(", ")}`,
        },
        400
      );
    }
    patch.scan_threshold = body.scan_threshold;
  }

  const updated = updateApp(app.id, patch);
  if (!updated) {
    return c.json({ error: "App not found" }, 404);
  }

  return c.json(toConfigResponse(updated));
});

apiRoutes.put("/app/scan-threshold", async (c) => {
  const app = c.get("app");
  const body = await c.req.json().catch(() => null);
  if (!body || !isValidThreshold(body.threshold)) {
    return c.json(
      {
        error: `threshold must be one of: ${THRESHOLDS.join(", ")}`,
      },
      400
    );
  }
  const updated = updateApp(app.id, {
    scan_threshold: body.threshold as Threshold,
  });
  if (!updated) return c.json({ error: "App not found" }, 404);
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
      scan: summarizeScanForResponse(result.scan),
      note: result.domain
        ? `TLS certificate is issued on first request and may take 5-15 seconds. Use /app/status to verify without TLS.`
        : undefined,
    });
  } catch (err: any) {
    if (err instanceof ScanBlockedError) {
      // Keep app status untouched — the previous container is still
      // running. The deploy row is already recorded as "blocked".
      return c.json(
        {
          status: "blocked",
          error: err.message,
          image_tag: err.imageTag,
          deploy_id: err.deployId,
          scan: summarizeScanForResponse(err.scan),
          hint: `Fix the findings, lower scan_threshold, or deploy again. Full report: GET /api/v1/app/deploys/${err.deployId}/scan`,
        },
        409
      );
    }
    updateApp(app.id, { status: "failed" });
    notifyDeployFailure(app.name ?? app.id, app.id, err?.message ?? "Deploy failed");
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

apiRoutes.get("/app/deploys/:deployId/scan", (c) => {
  const app = c.get("app");
  const deployId = parseInt(c.req.param("deployId"), 10);
  if (Number.isNaN(deployId)) {
    return c.json({ error: "Invalid deploy id" }, 400);
  }
  const deploy = getDeploy(app.id, deployId);
  if (!deploy) return c.json({ error: "Deploy not found" }, 404);
  const report = deploy.scan_report ? JSON.parse(deploy.scan_report) : null;
  return c.json({
    deploy_id: deploy.id,
    image_tag: deploy.image_tag,
    created_at: deploy.created_at,
    scan_status: deploy.scan_status,
    scan: report,
  });
});

apiRoutes.get("/app/scan", (c) => {
  const app = c.get("app");
  const deploy = getLatestDeployWithScan(app.id);
  if (!deploy) return c.json({ scan: null });
  const report = deploy.scan_report ? JSON.parse(deploy.scan_report) : null;
  return c.json({
    deploy_id: deploy.id,
    image_tag: deploy.image_tag,
    created_at: deploy.created_at,
    scan_status: deploy.scan_status,
    scan: report,
  });
});

apiRoutes.get("/app/status", async (c) => {
  const app = c.get("app");
  try {
    const status = await getAppStatus(app);
    const latest = getLatestDeployWithScan(app.id);
    const scanSummary = latest?.scan_summary
      ? JSON.parse(latest.scan_summary)
      : null;
    return c.json({
      ...status,
      scan_threshold: app.scan_threshold,
      latest_scan: latest
        ? {
            deploy_id: latest.id,
            image_tag: latest.image_tag,
            created_at: latest.created_at,
            ...scanSummary,
          }
        : null,
    });
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
      basicAuth: appBasicAuth(updated),
      ssoEnabled: !!updated.sso_enabled,
    });
  }

  return c.json(toConfigResponse(updated));
});

// ── Basic auth ──────────────────────────────────────────
apiRoutes.put("/app/basic-auth", async (c) => {
  const app = c.get("app");
  const body = await c.req.json().catch(() => null);

  if (!body || typeof body !== "object") {
    return c.json({ error: "Invalid JSON body" }, 400);
  }

  const enabled = !!body.enabled;

  let patch: Parameters<typeof updateApp>[1];

  if (!enabled) {
    patch = {
      basic_auth_enabled: 0,
      basic_auth_username: null,
      basic_auth_htpasswd: null,
    };
  } else {
    const username =
      typeof body.username === "string" ? body.username.trim() : "";
    const password = typeof body.password === "string" ? body.password : "";

    if (!username || !/^[A-Za-z0-9._\-@]+$/.test(username)) {
      return c.json(
        { error: "username is required and must match [A-Za-z0-9._-@]+" },
        400
      );
    }
    if (password.length < 6) {
      return c.json(
        { error: "password must be at least 6 characters" },
        400
      );
    }

    patch = {
      basic_auth_enabled: 1,
      basic_auth_username: username,
      basic_auth_htpasswd: buildHtpasswd(username, password),
    };
  }

  const updated = updateApp(app.id, patch);
  if (!updated) return c.json({ error: "App not found" }, 404);

  if (updated.domain) {
    await writeAppRoute({
      appId: updated.id,
      containerName: appContainerName(updated.id),
      domain: updated.domain,
      customDomain: updated.custom_domain,
      port: updated.port,
      basicAuth: appBasicAuth(updated),
      ssoEnabled: !!updated.sso_enabled,
    });
  }

  return c.json({
    app_id: updated.id,
    basic_auth: {
      enabled: !!updated.basic_auth_enabled,
      username: updated.basic_auth_username,
    },
  });
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

// ── SSO ─────────────────────────────────────────────────
apiRoutes.get("/app/sso", (c) => {
  const app = c.get("app");
  return c.json({
    app_id: app.id,
    sso_enabled: !!app.sso_enabled,
    allowed_emails: getAppAllowedEmails(app.id),
  });
});

apiRoutes.put("/app/sso", async (c) => {
  const app = c.get("app");
  const body = await c.req.json().catch(() => null);
  if (!body || typeof body !== "object") {
    return c.json({ error: "Invalid JSON body" }, 400);
  }

  const enabled =
    body.enabled !== undefined ? !!body.enabled : !!app.sso_enabled;
  const emails = Array.isArray(body.allowed_emails)
    ? body.allowed_emails
    : undefined;

  if (emails) {
    for (const e of emails) {
      if (typeof e !== "string" || !e.includes("@")) {
        return c.json({ error: `Invalid email: ${e}` }, 400);
      }
    }
    setAppAllowedEmails(
      app.id,
      emails.map((e: string) => e.toLowerCase().trim())
    );
  }

  const updated = updateApp(app.id, { sso_enabled: enabled ? 1 : 0 });
  if (!updated) return c.json({ error: "App not found" }, 404);

  if (updated.domain) {
    await writeAppRoute({
      appId: updated.id,
      containerName: appContainerName(updated.id),
      domain: updated.domain,
      customDomain: updated.custom_domain,
      port: updated.port,
      basicAuth: appBasicAuth(updated),
      ssoEnabled: !!updated.sso_enabled,
    });
  }

  return c.json({
    app_id: updated.id,
    sso_enabled: !!updated.sso_enabled,
    allowed_emails: getAppAllowedEmails(updated.id),
  });
});

// ── Rollback ────────────────────────────────────────────
apiRoutes.post("/app/rollback", async (c) => {
  const app = c.get("app");

  if (!isConfigured(app)) {
    return c.json({ error: "App is not configured yet." }, 409);
  }

  let targetDeployId: number | undefined;
  // Body is optional: omitted = previous successful deploy.
  if (c.req.header("content-length")) {
    const body = await c.req.json().catch(() => null);
    if (body && body.deploy_id !== undefined) {
      const id = Number(body.deploy_id);
      if (!Number.isInteger(id) || id <= 0) {
        return c.json(
          { error: "deploy_id must be a positive integer" },
          400
        );
      }
      targetDeployId = id;
    }
  }

  try {
    const result = await rollbackApp(app, targetDeployId);
    return c.json({ status: "rolled_back", ...result });
  } catch (err: any) {
    return c.json({ error: err?.message ?? "Rollback failed" }, 500);
  }
});

apiRoutes.get("/app/deploys", (c) => {
  const app = c.get("app");
  const limit = Math.min(
    Math.max(parseInt(c.req.query("limit") ?? "20", 10) || 20, 1),
    100
  );
  const deploys = getLatestDeploys(app.id, limit).map((d) => ({
    id: d.id,
    image_tag: d.image_tag,
    status: d.status,
    scan_status: d.scan_status,
    scan_summary: d.scan_summary ? JSON.parse(d.scan_summary) : null,
    created_at: d.created_at,
    is_current: d.image_tag === app.image_tag && d.status === "success",
  }));
  return c.json({
    app_id: app.id,
    current_image_tag: app.image_tag,
    deploys,
  });
});
