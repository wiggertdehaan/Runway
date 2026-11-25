import { resolveHardening } from "../deploy/hardening.js";
import { Hono, type Context } from "hono";
import { apiAuth, type ApiEnv } from "../middleware/auth.js";
import { apiAuthorize } from "../middleware/api-authorize.js";
import { apiAudit } from "../middleware/api-audit.js";
import { apiTokenLimit } from "../middleware/token-limit.js";
import {
  appVisibleTo,
  appsVisibleTo,
  createApp,
  getApp,
  defaultPortForRuntime,
  isAppOwner,
  isConfigured,
  previousKeyActive,
  rotateAppKey,
  RUNTIMES,
  updateApp,
  type App,
  type Runtime,
} from "../db/apps.js";
import { logAudit } from "../db/audit.js";
import { safeName } from "../util/audit-detail.js";
import { emitEvent, getEventRowByCursor, listEvents, type EventAudience } from "../db/events.js";
import { buildEventDetail, decodeCursor, encodeCursor } from "../util/events.js";
import { getUser } from "../db/users.js";
import {
  getUserTokenById,
  listAllUserTokens,
  listUserTokens,
  revokeUserToken,
} from "../db/user-tokens.js";
import { scopeCovers } from "../util/token-scopes.js";
import { cleanDescription } from "../util/description.js";
import { forgetKey } from "../util/key-reveal.js";
import { mayRebuild, mayRescan, rebuildBlockedReason, rescanBlockedReason } from "../ui/app-page.js";
import { RebuildBusyError, startRebuildRun } from "../deploy/rebuild.js";
import { rescanApp } from "../deploy/periodic-scanner.js";
import { endRescan, tryBeginRescan } from "../deploy/rescan-guard.js";
import { getSetting, getMaxUploadBytes, slugify } from "../db/settings.js";
import {
  deployApp,
  getAppLogs,
  getAppStatus,
  rollbackApp,
  ScanBlockedError,
  UnhealthyDeployError,
  PreflightRejectedError,
} from "../deploy/index.js";
import {
  latestSource,
  sourceForDeploy,
  hasSourceForDeploy,
  type SourceRef,
} from "../deploy/source.js";
import { readFile, rm } from "node:fs/promises";
import { receiveUpload, UploadTooLargeError } from "../deploy/upload.js";
import { inspectTarFile, tarLimits, UnsafeTarError } from "../deploy/safe-tar.js";
import { THRESHOLDS, isValidThreshold, effectiveThreshold, type Threshold } from "../deploy/scan.js";
import { getDeploy, getLatestDeployWithScan, getLatestDeploys, parseBaseImages } from "../db/deploys.js";
import { appBasicAuth, buildHtpasswd, writeAppRoute } from "../deploy/gateway.js";
import { appContainerName } from "../deploy/index.js";
import { getEnvVars, setEnvVars, deleteEnvVar } from "../db/env.js";
import { notifyDeployFailure } from "../util/webhook.js";
import { getVolumes, setVolumes, deleteVolume } from "../db/volumes.js";
import { getAppAllowedEmails, setAppAllowedEmails } from "../db/app-emails.js";
import { getAppSkillIds, setAppSkillIds } from "../db/app-skills.js";
import { getSkill, listEnabledSkills } from "../db/skills.js";
import { getInstanceIdentity } from "../instance/identity.js";

/**
 * Validate a JSON `skill_ids` value to a clean string array of
 * currently-enabled skill ids. Returns either `{ ok: true, ids }` or
 * `{ ok: false, error }`. Used by /app/configure (optional creation
 * input) and /app/skills (full overwrite).
 */
function validateSkillIds(
  raw: unknown,
): { ok: true; ids: string[] } | { ok: false; error: string } {
  if (!Array.isArray(raw)) {
    return { ok: false, error: "skill_ids must be an array" };
  }
  const requested = raw.filter((v): v is string => typeof v === "string");
  if (requested.length !== raw.length) {
    return { ok: false, error: "skill_ids must contain only strings" };
  }
  const enabled = new Set(listEnabledSkills().map((s) => s.id));
  const unknown = requested.filter((id) => !enabled.has(id));
  if (unknown.length > 0) {
    return {
      ok: false,
      error: `Unknown or disabled skills: ${unknown.join(", ")}`,
    };
  }
  return { ok: true, ids: requested };
}
import {
  checkGeneratedDomain,
  isUniqueViolation,
  validateCustomDomain,
} from "../util/domain.js";

export const apiRoutes = new Hono<ApiEnv>();

apiRoutes.use("/*", apiAuth);
// S21: allowance per key (read / write / heavy). A refused request is audited
// once, as a counted row, by the limiter itself; it never reaches apiAudit.
apiRoutes.use("/*", apiTokenLimit);
// S18: what this caller may do on this request: the token's scope, and for a
// user token which app it is pointed at and whether the person may see it.
apiRoutes.use("/*", apiAuthorize);
// S12: every call that changes something (and the two sensitive reads) is
// audited here, once, for all routes. Keep it directly after apiAuth.
apiRoutes.use("/*", apiAudit);

function toConfigResponse(app: App) {
  const relevantSkillIds = getAppSkillIds(app.id);
  const relevantSkills = relevantSkillIds
    .map((id) => {
      const s = getSkill(id);
      if (!s || !s.enabled) return null;
      return { id: s.id, name: s.name, description: s.description };
    })
    .filter((s): s is { id: string; name: string; description: string | null } => s !== null);

  return {
    id: app.id,
    name: app.name,
    runtime: app.runtime,
    description: app.description ?? null,
    domain: app.domain,
    custom_domain: app.custom_domain,
    port: app.port,
    cpu_limit: app.cpu_limit,
    memory_limit: app.memory_limit,
    hardening: resolveHardening(app.hardening_profile).mode,
    read_only_rootfs: app.readonly_rootfs === 1,
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
    relevant_skills: relevantSkills,
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
  if (domain) {
    const problem = checkGeneratedDomain(domain, app.id);
    if (problem === "conflict") {
      return c.json(
        { error: "That name is already in use. Choose a different name." },
        409
      );
    }
    if (problem === "reserved") {
      return c.json(
        { error: "That name is reserved. Choose a different name." },
        400
      );
    }
  }
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

  let skillIds: string[] | null = null;
  if (body.skill_ids !== undefined) {
    const result = validateSkillIds(body.skill_ids);
    if (!result.ok) return c.json({ error: result.error }, 400);
    skillIds = result.ids;
  }

  let updated;
  try {
    updated = updateApp(app.id, patch);
  } catch (err) {
    // Lost a race against another app taking the same hostname.
    if (isUniqueViolation(err)) {
      return c.json(
        { error: "That name is already in use. Choose a different name." },
        409
      );
    }
    throw err;
  }
  if (!updated) {
    return c.json({ error: "App not found" }, 404);
  }
  if (skillIds !== null) {
    setAppSkillIds(updated.id, skillIds);
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
 * raw request body. Content-Type must be application/x-tar. The body is
 * streamed to disk under the upload limit and every entry is checked
 * (deploy/safe-tar.ts) before the build sees it; whatever layout the
 * caller uses inside those limits is what `docker build` gets.
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

  const maxUploadBytes = getMaxUploadBytes();
  const lengthHeader = c.req.header("content-length");
  if (lengthHeader && parseInt(lengthHeader, 10) > maxUploadBytes) {
    return c.json(
      { error: `Upload exceeds limit of ${maxUploadBytes} bytes` },
      413
    );
  }

  // S06: stream to a file with a hard cap (works without Content-Length),
  // check every tar entry before anything is read into memory or unpacked.
  let upload;
  try {
    upload = await receiveUpload(c.req.raw.body, maxUploadBytes);
  } catch (err) {
    if (err instanceof UploadTooLargeError) {
      return c.json({ error: `Upload exceeds limit of ${maxUploadBytes} bytes` }, 413);
    }
    return c.json({ error: "Upload was interrupted" }, 400);
  }
  if (upload.bytes === 0) {
    if (upload.path) await rm(upload.path, { force: true });
    return c.json({ error: "Empty upload" }, 400);
  }

  let tarBuffer: Buffer;
  try {
    await inspectTarFile(upload.path, tarLimits(maxUploadBytes));
    // Bounded by the upload limit (checked above); the rest of the deploy
    // pipeline still works on a Buffer.
    tarBuffer = await readFile(upload.path);
  } catch (err) {
    if (err instanceof UnsafeTarError) {
      return c.json(
        { status: "rejected", error: err.message, code: err.code },
        400
      );
    }
    throw err;
  } finally {
    await rm(upload.path, { force: true }).catch(() => {});
  }

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
      const appThreshold = (app.scan_threshold ?? "none") as Threshold;
      const floor = (getSetting("min_scan_threshold") ?? "none") as Threshold;
      const effective = effectiveThreshold(
        appThreshold,
        floor,
        !!app.scan_floor_exempt,
      );
      const floorActive = effective !== appThreshold && floor !== "none";
      const hint = floorActive
        ? `Server-wide scan floor (${floor}) raised this app's effective threshold above scan_threshold=${appThreshold}. Either fix the findings, ask the admin to grant scan_floor_exempt, or relax min_scan_threshold. Full report: GET /api/v1/app/deploys/${err.deployId}/scan`
        : `Fix the findings, lower scan_threshold, or deploy again. Full report: GET /api/v1/app/deploys/${err.deployId}/scan`;
      return c.json(
        {
          status: "blocked",
          error: err.message,
          image_tag: err.imageTag,
          deploy_id: err.deployId,
          scan_threshold: appThreshold,
          effective_scan_threshold: effective,
          scan: summarizeScanForResponse(err.scan),
          hint,
        },
        409
      );
    }
    if (err instanceof PreflightRejectedError) {
      emitEvent({ appId: app.id, code: "deploy_failed:preflight" });
      return c.json(
        {
          status: "rejected",
          error: err.message,
          pattern: err.pattern,
          hint: "Remove references to cloud metadata endpoints from your build context.",
        },
        400
      );
    }
    updateApp(app.id, { status: "failed" });
    // A container that never became healthy was already recorded (and reported
    // as an event) by the deploy itself; anything else is a build failure.
    if (!(err instanceof UnhealthyDeployError)) {
      emitEvent({ appId: app.id, code: "deploy_failed:build" });
    }
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

/**
 * Download a deploy's build context as a tar stream. Lets the user pull
 * the project source back to a fresh working directory (e.g. a new Claude
 * Code session) without the original local checkout. Defaults to the most
 * recent saved snapshot; `?deploy=<id>` selects a specific deploy.
 */
apiRoutes.get("/app/source", async (c) => {
  const app = c.get("app");

  const deployParam = c.req.query("deploy");
  let ref: SourceRef | null;
  let filenameSuffix = "source";
  if (deployParam !== undefined) {
    const deployId = parseInt(deployParam, 10);
    if (!Number.isInteger(deployId) || deployId < 1) {
      return c.json({ error: "deploy must be a positive integer" }, 400);
    }
    ref = sourceForDeploy(app.id, deployId);
    filenameSuffix = `deploy-${deployId}`;
    if (!ref) {
      return c.json(
        {
          error: `No source retained for deploy #${deployId}`,
          hint: "Only the most recent snapshots are kept (see RUNWAY_SOURCE_RETENTION). List deploys to see which still have source.",
        },
        404
      );
    }
  } else {
    ref = latestSource(app.id);
    if (!ref) {
      return c.json(
        {
          error: "No source available for this app",
          hint: "Source is saved on each successful deploy. Run a deploy first.",
        },
        404
      );
    }
  }

  let buf: Buffer;
  try {
    buf = await readFile(ref.path);
  } catch (err: any) {
    return c.json({ error: err?.message ?? "Failed to read source" }, 500);
  }
  const base = slugify(app.name ?? app.id) || app.id;
  const filename = `${base}-${filenameSuffix}.tar`;
  c.header("Content-Type", "application/x-tar");
  c.header("Content-Length", String(ref.bytes));
  c.header("Content-Disposition", `attachment; filename="${filename}"`);
  c.header("Last-Modified", ref.mtime.toUTCString());
  return c.body(new Uint8Array(buf));
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
  const toDelete: string[] = [];
  for (const [key, value] of Object.entries(env)) {
    if (typeof key !== "string" || !key.match(/^[A-Za-z_][A-Za-z0-9_]*$/)) {
      return c.json({ error: `Invalid env var name: ${key}` }, 400);
    }
    // PUT merges: present keys are upserted, `null` removes the
    // entry. Storing String(null) === "null" was a footgun — the
    // var stayed set and the agent thought it was cleared.
    if (value === null) {
      toDelete.push(key);
      continue;
    }
    if (typeof value !== "string" && typeof value !== "number" && typeof value !== "boolean") {
      return c.json(
        { error: `Env var '${key}' must be a string, number, boolean, or null` },
        400,
      );
    }
    clean[key] = String(value);
  }

  setEnvVars(app.id, clean);
  for (const key of toDelete) deleteEnvVar(app.id, key);
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

  const customDomainRaw =
    typeof body.custom_domain === "string" ? body.custom_domain : "";

  const validation = validateCustomDomain(customDomainRaw, app.id);
  if (!validation.ok) {
    const message =
      validation.error === "conflict"
        ? "Domain already in use by another app"
        : validation.error === "reserved"
          ? "Domain is reserved (dashboard or base-domain subdomain)"
          : "Invalid domain name";
    return c.json({ error: message }, 400);
  }

  let updated;
  try {
    updated = updateApp(app.id, {
      custom_domain: validation.domain,
    });
  } catch (err) {
    if (isUniqueViolation(err)) {
      return c.json({ error: "Domain already in use by another app" }, 400);
    }
    throw err;
  }
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

// ── Description ─────────────────────────────────────────
// Short plain text: what the app is, for whom, what for. Same rights as the
// other settings (apiAuthorize: deploy scope, owner or admin). null or "" clears.
apiRoutes.put("/app/description", async (c) => {
  const app = c.get("app");
  const body = await c.req.json().catch(() => null);
  if (!body || typeof body !== "object" || !("description" in body)) {
    return c.json({ error: 'Body must be {"description": "..."} (or null to clear)' }, 400);
  }
  const checked = cleanDescription((body as { description: unknown }).description);
  if (!checked.ok) return c.json({ error: checked.error }, 400);
  const updated = updateApp(app.id, { description: checked.value });
  if (!updated) return c.json({ error: "App not found" }, 404);
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

// ── Skill profile (suggestions, not a gate) ────────────
apiRoutes.get("/app/skills", (c) => {
  const app = c.get("app");
  return c.json({
    app_id: app.id,
    skill_ids: getAppSkillIds(app.id),
  });
});

apiRoutes.put("/app/skills", async (c) => {
  const app = c.get("app");
  const body = await c.req.json().catch(() => null);
  if (!body || typeof body !== "object") {
    return c.json({ error: "Invalid JSON body" }, 400);
  }
  const result = validateSkillIds(body.skill_ids);
  if (!result.ok) return c.json({ error: result.error }, 400);

  setAppSkillIds(app.id, result.ids);
  return c.json({ app_id: app.id, skill_ids: getAppSkillIds(app.id) });
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
    has_source: hasSourceForDeploy(app.id, d.id),
    base_images: parseBaseImages(d),
  }));
  return c.json({
    app_id: app.id,
    current_image_tag: app.image_tag,
    deploys,
  });
});

// ── User-token routes (S18) ──────────────────────────────
// These exist for a person's token (rwu_…): who am I, which apps may I see,
// what can I start on them. An app key is refused on every one of them by
// apiAuthorize. The rights are the dashboard's own functions, evaluated on
// every request, so a token never knows more than the person does.

/** The person behind a user-token request. Only called on routes an app key cannot reach. */
function tokenUser(c: { get: (k: "actor") => import("../middleware/auth.js").Actor }) {
  const actor = c.get("actor");
  if (actor.kind !== "user-token") throw new Error("user token required");
  return actor;
}

apiRoutes.get("/me", (c) => {
  const actor = tokenUser(c);
  const token = getUserTokenById(actor.tokenId);
  return c.json({
    user: { id: actor.userId, username: actor.username, role: actor.role },
    token: {
      id: actor.tokenId,
      scope: actor.scope,
      expires_at: token?.expires_at ?? null,
    },
    // Which Runway this is (display only, same as the public /instance.json).
    instance: getInstanceIdentity(),
  });
});

apiRoutes.get("/apps", (c) => {
  const actor = tokenUser(c);
  const apps = appsVisibleTo(actor.userId, actor.role === "admin");
  return c.json({
    apps: apps.map((a) => ({
      id: a.id,
      name: a.name,
      runtime: a.runtime,
      description: a.description ?? null,
      status: a.status,
      domain: a.custom_domain ?? a.domain,
      configured: isConfigured(a),
      // The rights the person has on it, so a client can offer only what works.
      can: {
        rebuild: mayRebuild({ id: actor.userId, role: actor.role }, a),
        rescan: mayRescan({ id: actor.userId, role: actor.role }, a),
      },
    })),
  });
});

/**
 * Whose events this caller may read: an app key, its own app; a user token,
 * exactly the apps the person may see on the dashboard (an administrator: all),
 * decided on this request. `?app=` narrows a user token to one app it may see
 * (anything else answers 404, like every other app route).
 */
function eventAudience(c: Context<ApiEnv>): EventAudience | "not_found" {
  const actor = c.get("actor");
  const wanted = c.req.query("app");
  if (actor.kind === "app-key") {
    if (wanted && wanted !== actor.appId) return "not_found";
    return { all: false, appIds: [actor.appId] };
  }
  const user = { id: actor.userId, role: actor.role };
  if (wanted) {
    const app = getApp(safeName(wanted, 40));
    return app && appVisibleTo(user, app) ? { all: false, appIds: [app.id] } : "not_found";
  }
  if (actor.role === "admin") return { all: true };
  return { all: false, appIds: appsVisibleTo(actor.userId, false).map((a) => a.id) };
}

/**
 * Events since a cursor (S12 follow-up, MCP "events"). Pull, not push: a client
 * keeps the `next_cursor` and asks again. An event is a type, an app id and a
 * code; details are on /events/:id. No `since`: the latest events and a cursor.
 */
apiRoutes.get("/events", (c) => {
  const audience = eventAudience(c);
  if (audience === "not_found") return c.json({ error: "App not found." }, 404);

  const rawSince = c.req.query("since");
  let since: number | null = null;
  if (rawSince !== undefined && rawSince !== "") {
    since = decodeCursor(rawSince);
    if (since === null) return c.json({ error: "Invalid cursor. Use the next_cursor of an earlier answer." }, 400);
  }
  const limit = Math.max(1, Math.min(parseInt(c.req.query("limit") ?? "50", 10) || 50, 200));

  const page = listEvents({ since, limit, audience, initial: 20 });
  return c.json({
    events: page.events,
    next_cursor: encodeCursor(page.nextCursor),
    has_more: page.hasMore,
    ...(page.cursorExpired
      ? {
          cursor_expired: true,
          note: "Your cursor is older than the events this server keeps (or was not issued here). Events in between are lost; these are the oldest that remain.",
        }
      : {}),
    ...(since === null ? { initial: true } : {}),
  });
});

/** One event in detail: known fields only. The same rights as the list; no such event and not yours look alike. */
apiRoutes.get("/events/:eventId", (c) => {
  const row = getEventRowByCursor(c.req.param("eventId"));
  const audience = eventAudience(c);
  const visible =
    row !== undefined &&
    audience !== "not_found" &&
    (audience.all || audience.appIds.includes(row.app_id));
  const detail = visible ? buildEventDetail(row!) : null;
  if (!detail) return c.json({ error: "Event not found." }, 404);
  return c.json({ event: detail });
});

/** Make a new, unconfigured app owned by the person. Configure it with /app/configure. */
apiRoutes.post("/apps", (c) => {
  const actor = tokenUser(c);
  const app = createApp({ id: actor.userId, username: actor.username });
  c.set("app", app);
  logAudit(actor.userId, actor.username, "app_created", { detail: `${app.id} (by api token)` });
  return c.json({ id: app.id, configured: false }, 201);
});

apiRoutes.get("/tokens", (c) => {
  const actor = tokenUser(c);
  return c.json({ tokens: listUserTokens(actor.userId) });
});

/** Admin scope only: every person's tokens (never the tokens themselves). */
apiRoutes.get("/tokens/all", (c) => {
  return c.json({ tokens: listAllUserTokens() });
});

/**
 * Revoke a token. Your own: allowed with a deploy token. Somebody else's: the
 * admin scope, and an administrator right now.
 */
apiRoutes.delete("/tokens/:tokenId", (c) => {
  const actor = tokenUser(c);
  const id = c.req.param("tokenId");
  const target = getUserTokenById(id);
  if (!target) return c.json({ error: "Token not found." }, 404);
  const own = target.user_id === actor.userId;
  if (!own && !(scopeCovers(actor.scope, "admin") && actor.role === "admin")) {
    // Same answer as "no such token": do not confirm that someone else's id exists.
    return c.json({ error: "Token not found." }, 404);
  }
  const done = revokeUserToken(id, actor.userId);
  if (!done) return c.json({ error: "Token not found." }, 404);
  const owner = getUser(done.user_id);
  logAudit(actor.userId, actor.username, "user_token_revoked", {
    targetUserId: done.user_id,
    targetUsername: owner?.username,
    detail: `${id} (by api token${own ? "" : ", administrator"})`,
  });
  return c.json({ revoked: true });
});

/** Start a rebuild of this app: its owner or an administrator, one run at a time. */
apiRoutes.post("/app/rebuild", (c) => {
  const actor = tokenUser(c);
  const app = c.get("app");
  const user = { id: actor.userId, role: actor.role };
  // The second, explicit check: apiAuthorize already limited the app to
  // those the person may see, and this keeps the rule next to the action.
  if (!mayRebuild(user, app)) return c.json({ error: "App not found." }, 404);
  const blocked = rebuildBlockedReason(app);
  if (blocked) return c.json({ error: blocked, code: "blocked" }, 409);
  try {
    const runId = startRebuildRun({
      trigger: "manual",
      appIds: [app.id],
      onFinished: (results) => {
        const r = results.find((x) => x.app_id === app.id) ?? results[0];
        logAudit(actor.userId, actor.username, "app_rebuild_finished", {
          detail: `${app.id} run ${runId}: ${r?.outcome ?? "no result"}`,
        });
      },
    });
    logAudit(actor.userId, actor.username, "app_rebuild_started", {
      detail: `${app.id} run ${runId}${actor.role === "admin" ? "" : " (by owner)"} (by api token)`,
    });
    return c.json({ started: true, run_id: runId }, 202);
  } catch (err) {
    if (err instanceof RebuildBusyError) {
      return c.json({ error: "A rebuild is already running. Only one runs at a time.", code: "busy" }, 409);
    }
    throw err;
  }
});

/** Scan the running image again now. One manual scan at a time. */
apiRoutes.post("/app/rescan", async (c) => {
  const actor = tokenUser(c);
  const app = c.get("app");
  const user = { id: actor.userId, role: actor.role };
  if (!mayRescan(user, app)) return c.json({ error: "App not found." }, 404);
  const blocked = rescanBlockedReason(app);
  if (blocked) return c.json({ error: blocked, code: "blocked" }, 409);
  if (!tryBeginRescan(app.id)) {
    return c.json({ error: "A rescan is already running. Only one runs at a time.", code: "busy" }, 409);
  }
  try {
    await rescanApp(app);
  } finally {
    endRescan(app.id);
  }
  logAudit(actor.userId, actor.username, "app_rescanned", {
    detail: `${app.id}${actor.role === "admin" ? "" : " (by owner)"} (by api token)`,
  });
  return c.json({ rescanned: true });
});

/**
 * Replace this app's API key (S11). Body: `{ "grace_minutes": 0..10080 }`: how
 * long the old key keeps working (default 0 = it stops now). The new key is in
 * the response and is not shown again. The owner needs a deploy token; the
 * key of an app that is not yours needs the admin scope.
 */
apiRoutes.post("/app/rotate-key", async (c) => {
  const actor = tokenUser(c);
  const app = c.get("app");
  const own = isAppOwner({ id: actor.userId }, app);
  if (!own && !(scopeCovers(actor.scope, "admin") && actor.role === "admin")) {
    return c.json({ error: "Rotating the key of an app that is not yours needs the admin scope." }, 403);
  }
  const body = (await c.req.json().catch(() => ({}))) as { grace_minutes?: unknown };
  const grace =
    typeof body.grace_minutes === "number" && Number.isFinite(body.grace_minutes)
      ? body.grace_minutes
      : 0;
  const rotated = rotateAppKey(app.id, grace);
  if (!rotated) return c.json({ error: "App not found." }, 404);
  forgetKey(app.id);
  logAudit(actor.userId, actor.username, "app_key_rotated", {
    detail: `${app.id} overlap ${Math.max(0, Math.floor(grace))} min (by api token)`,
  });
  return c.json({
    key: rotated.key,
    hint: rotated.app.api_key_hint,
    previous_key_valid_until: previousKeyActive(rotated.app) ? rotated.app.prev_key_expires_at : null,
  });
});
