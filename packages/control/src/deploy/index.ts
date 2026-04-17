import type { Readable } from "node:stream";
import { updateApp, type App } from "../db/apps.js";
import { recordDeploy, getPreviousSuccessfulDeploy } from "../db/deploys.js";
import { getEnvVars } from "../db/env.js";
import { getVolumes } from "../db/volumes.js";
import {
  buildImageFromTar,
  getContainerLogs,
  getContainerStatus,
  removeContainerByName,
  runContainer,
} from "./docker.js";
import { deleteAppRoute, writeAppRoute } from "./gateway.js";
import {
  buildScanResult,
  emptyCounts,
  isValidThreshold,
  scanImage,
  scanSource,
  trivyAvailable,
  type Finding,
  type ScanResult,
  type Threshold,
} from "./scan.js";

function dockerSafeId(appId: string): string {
  return appId.toLowerCase().replace(/[^a-z0-9-]/g, "-");
}

export function appContainerName(appId: string): string {
  return `runway-app-${dockerSafeId(appId)}`;
}

export function appImageTag(appId: string): string {
  return `runway-app-${dockerSafeId(appId)}:latest`;
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

function resolveThreshold(app: App): Threshold {
  return isValidThreshold(app.scan_threshold) ? app.scan_threshold : "none";
}

export async function deployApp(input: DeployInput): Promise<DeployResult> {
  const { app, tar } = input;
  const imageTag = appImageTag(app.id);
  const containerName = appContainerName(app.id);
  const threshold = resolveThreshold(app);

  const tarBuffer = Buffer.isBuffer(tar) ? tar : null;

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
    });
  }

  updateApp(app.id, {
    status: "running",
    image_tag: imageTag,
    container_id: run.containerId,
  });

  recordDeploy(app.id, imageTag, "success", {
    log: build.log,
    scanStatus: scan.status,
    scanSummary,
    scanReport: scan,
  });

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

export async function rollbackApp(app: App): Promise<DeployResult> {
  const currentTag = appImageTag(app.id);
  const prev = getPreviousSuccessfulDeploy(app.id, currentTag);
  if (!prev || !prev.image_tag) {
    throw new Error("No previous successful deploy to roll back to");
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
