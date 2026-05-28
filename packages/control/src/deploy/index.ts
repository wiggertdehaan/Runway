import type { Readable } from "node:stream";
import { updateApp, type App } from "../db/apps.js";
import {
  recordDeploy,
  getPreviousSuccessfulDeploy,
  getDeploy,
  getSuccessfulImageTags,
} from "../db/deploys.js";
import { getEnvVars } from "../db/env.js";
import { getVolumes } from "../db/volumes.js";
import {
  buildImageFromTar,
  getContainerLogs,
  getContainerStatus,
  removeContainerByName,
  removeImageByTag,
  runContainer,
} from "./docker.js";
import { appBasicAuth, deleteAppRoute, writeAppRoute } from "./gateway.js";
import {
  buildScanResult,
  effectiveThreshold,
  emptyCounts,
  isValidThreshold,
  scanImage,
  scanSource,
  trivyAvailable,
  type Finding,
  type ScanResult,
  type Threshold,
} from "./scan.js";
import { getKeepImageVersions, getSetting } from "../db/settings.js";
import { preflightCheckTar, PreflightRejectedError } from "./preflight.js";
import { saveSource, pruneOldSources, deleteAllSources } from "./source.js";
export { PreflightRejectedError } from "./preflight.js";

function dockerSafeId(appId: string): string {
  return appId.toLowerCase().replace(/[^a-z0-9-]/g, "-");
}

export function appContainerName(appId: string): string {
  return `runway-app-${dockerSafeId(appId)}`;
}

/**
 * The base image name for an app (no tag). Each deploy produces a
 * unique version tag (see newImageTag); the base name is shared
 * across versions so the Docker image reference always groups them.
 */
export function appImageName(appId: string): string {
  return `runway-app-${dockerSafeId(appId)}`;
}

/**
 * Generate a fresh, unique image tag for one build. Tags are
 * monotonically sortable (leading timestamp) so sorting by tag
 * approximates deploy order even without the deploys table.
 */
export function newImageTag(appId: string): string {
  const ts = Date.now().toString(36);
  const rnd = Math.random().toString(36).slice(2, 8);
  return `${appImageName(appId)}:v${ts}-${rnd}`;
}

function volumeSafeName(mountPath: string): string {
  return mountPath.replace(/^\//, "").replace(/[^a-z0-9]/gi, "-").toLowerCase();
}

function buildVolumeBinds(appId: string) {
  const volumes = getVolumes(appId);
  return volumes.map(
    (v) =>
      `runway-data-${dockerSafeId(appId)}-${volumeSafeName(v.mount_path)}:${v.mount_path}`
  );
}

export interface DeployInput {
  app: App;
  tar: Readable | Buffer;
}

export interface DeployResult {
  app_id: string;
  image_tag: string;
  container_id: string;
  container_name: string;
  domain: string | null;
  log_tail: string;
  scan: ScanResult;
}

/**
 * Thrown when a deploy is halted because the scan produced findings at
 * or above the app's configured severity threshold. The existing
 * container keeps running; the new image is built but never started.
 */
export class ScanBlockedError extends Error {
  scan: ScanResult;
  imageTag: string;
  deployId: number;
  constructor(scan: ScanResult, imageTag: string, deployId: number) {
    const top = scan.findings[0];
    super(
      top
        ? `Deploy blocked by scan: ${top.severity} ${top.id}${top.pkg ? ` in ${top.pkg}` : ""}`
        : "Deploy blocked by scan"
    );
    this.scan = scan;
    this.imageTag = imageTag;
    this.deployId = deployId;
  }
}

async function runScans(
  tarBuffer: Buffer | null,
  imageTag: string,
  threshold: Threshold
): Promise<ScanResult> {
  if (!trivyAvailable()) {
    return {
      status: "skipped",
      counts: emptyCounts(),
      findings: [],
      error: "trivy binary not found",
    };
  }

  const findings: Finding[] = [];
  const errors: string[] = [];

  if (tarBuffer) {
    try {
      findings.push(...(await scanSource(tarBuffer)));
    } catch (err: any) {
      errors.push(`source scan failed: ${err?.message ?? err}`);
    }
  }

  try {
    findings.push(...(await scanImage(imageTag)));
  } catch (err: any) {
    errors.push(`image scan failed: ${err?.message ?? err}`);
  }

  // Both legs failed and nothing was found → truly skipped.
  if (errors.length === (tarBuffer ? 2 : 1) && findings.length === 0) {
    return {
      status: "skipped",
      counts: emptyCounts(),
      findings: [],
      error: errors.join("; "),
    };
  }

  const result = buildScanResult(findings, threshold);
  if (errors.length > 0) {
    result.error = errors.join("; ");
  }
  return result;
}

async function pruneOldImages(appId: string): Promise<void> {
  const tags = getSuccessfulImageTags(appId);
  const toRemove = tags.slice(getKeepImageVersions());
  for (const tag of toRemove) {
    try {
      await removeImageByTag(tag);
    } catch {
      // Pruning is best-effort — never fail a deploy because cleanup
      // tripped on something weird.
    }
  }
}

function resolveThreshold(app: App): Threshold {
  const appThreshold: Threshold = isValidThreshold(app.scan_threshold)
    ? app.scan_threshold
    : "none";
  const serverFloor = (getSetting("min_scan_threshold") ?? "none") as Threshold;
  const exempt = !!app.scan_floor_exempt;
  return effectiveThreshold(appThreshold, serverFloor, exempt);
}

export async function deployApp(input: DeployInput): Promise<DeployResult> {
  const { app, tar } = input;
  const imageTag = newImageTag(app.id);
  const containerName = appContainerName(app.id);
  const threshold = resolveThreshold(app);

  const tarBuffer = Buffer.isBuffer(tar) ? tar : null;

  // Block obvious cloud-metadata probes in the build context before we
  // hand it to BuildKit. Network isolation stops control-plane access
  // from build sandboxes; this catches the remaining link-local /
  // cloud-metadata reach-out with minimal false-positive risk.
  if (tarBuffer) preflightCheckTar(tarBuffer);

  updateApp(app.id, { status: "building" });

  const build = await buildImageFromTar(tarBuffer ?? tar, { imageTag });

  updateApp(app.id, { status: "scanning" });

  const scan = await runScans(tarBuffer, imageTag, threshold);
  const scanSummary = { status: scan.status, counts: scan.counts };

  if (scan.status === "blocked") {
    const deploy = recordDeploy(app.id, imageTag, "blocked", {
      log: build.log,
      scanStatus: scan.status,
      scanSummary,
      scanReport: scan,
    });
    throw new ScanBlockedError(scan, imageTag, deploy.id);
  }

  updateApp(app.id, { status: "starting" });

  const env = getEnvVars(app.id);

  const run = await runContainer({
    containerName,
    imageTag,
    port: app.port,
    env,
    volumes: buildVolumeBinds(app.id),
    cpuLimit: app.cpu_limit,
    memoryLimit: app.memory_limit,
    healthCheckPath: app.health_check_path,
  });

  if (app.domain) {
    await writeAppRoute({
      appId: app.id,
      containerName,
      domain: app.domain,
      customDomain: app.custom_domain,
      port: app.port,
      basicAuth: appBasicAuth(app),
      ssoEnabled: !!app.sso_enabled,
    });
  }

  updateApp(app.id, {
    status: "running",
    image_tag: imageTag,
    container_id: run.containerId,
  });

  const deploy = recordDeploy(app.id, imageTag, "success", {
    log: build.log,
    scanStatus: scan.status,
    scanSummary,
    scanReport: scan,
  });

  // Persist the build context per deploy so the project source can later
  // be pulled back to a fresh working directory (runway_pull / GET
  // /api/v1/app/source). Best-effort: don't fail the deploy if the disk
  // write trips. Only saved on a successful deploy so a broken upload
  // never replaces a previous good source.
  if (tarBuffer) {
    try {
      saveSource(app.id, deploy.id, tarBuffer);
      pruneOldSources(app.id);
    } catch {
      // ignore
    }
  }

  await pruneOldImages(app.id);

  const logTail = build.log.split("\n").slice(-20).join("\n");

  return {
    app_id: app.id,
    image_tag: imageTag,
    container_id: run.containerId,
    container_name: containerName,
    domain: app.domain,
    log_tail: logTail,
    scan,
  };
}

export async function rollbackApp(
  app: App,
  targetDeployId?: number
): Promise<DeployResult> {
  const currentTag = app.image_tag ?? undefined;

  let prev: { id: number; image_tag: string | null; status: string } | undefined;
  if (targetDeployId !== undefined) {
    prev = getDeploy(app.id, targetDeployId);
    if (!prev) {
      throw new Error(`Deploy #${targetDeployId} not found for this app`);
    }
    if (prev.status !== "success") {
      throw new Error(
        `Deploy #${targetDeployId} has status '${prev.status}', only successful deploys can be restored`
      );
    }
    if (!prev.image_tag) {
      throw new Error(`Deploy #${targetDeployId} has no image to roll back to`);
    }
    if (prev.image_tag === app.image_tag) {
      throw new Error(
        `Deploy #${targetDeployId} is already the currently running image`
      );
    }
  } else {
    prev = getPreviousSuccessfulDeploy(app.id, currentTag);
    if (!prev || !prev.image_tag) {
      throw new Error("No previous successful deploy to roll back to");
    }
  }

  const containerName = appContainerName(app.id);
  const env = getEnvVars(app.id);

  updateApp(app.id, { status: "starting" });

  const run = await runContainer({
    containerName,
    imageTag: prev.image_tag,
    port: app.port,
    env,
    volumes: buildVolumeBinds(app.id),
    cpuLimit: app.cpu_limit,
    memoryLimit: app.memory_limit,
    healthCheckPath: app.health_check_path,
  });

  if (app.domain) {
    await writeAppRoute({
      appId: app.id,
      containerName,
      domain: app.domain,
      customDomain: app.custom_domain,
      port: app.port,
      basicAuth: appBasicAuth(app),
      ssoEnabled: !!app.sso_enabled,
    });
  }

  updateApp(app.id, {
    status: "running",
    image_tag: prev.image_tag,
    container_id: run.containerId,
  });

  recordDeploy(app.id, prev.image_tag, "success", { log: "Rolled back" });

  return {
    app_id: app.id,
    image_tag: prev.image_tag,
    container_id: run.containerId,
    container_name: containerName,
    domain: app.domain,
    log_tail: `Rolled back to ${prev.image_tag} (deploy #${prev.id})`,
    scan: {
      status: "skipped",
      counts: emptyCounts(),
      findings: [],
      error: "rollback reuses existing image",
    },
  };
}

export async function destroyApp(app: App): Promise<void> {
  await removeContainerByName(appContainerName(app.id));
  await deleteAppRoute(app.id);
  deleteAllSources(app.id);
}

export async function getAppStatus(app: App) {
  const name = appContainerName(app.id);
  const status = await getContainerStatus(name);
  return {
    app_id: app.id,
    stored_status: app.status,
    container_name: name,
    container: status,
  };
}

export async function getAppLogs(app: App, tail = 200) {
  const name = appContainerName(app.id);
  const logs = await getContainerLogs(name, tail);
  return {
    app_id: app.id,
    container_name: name,
    logs,
  };
}
