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
}

export async function deployApp(input: DeployInput): Promise<DeployResult> {
  const { app, tar } = input;
  const imageTag = appImageTag(app.id);
  const containerName = appContainerName(app.id);

  updateApp(app.id, { status: "building" });

  const build = await buildImageFromTar(tar, { imageTag });

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

  recordDeploy(app.id, imageTag, "success", build.log);

  const logTail = build.log.split("\n").slice(-20).join("\n");

  return {
    app_id: app.id,
    image_tag: imageTag,
    container_id: run.containerId,
    container_name: containerName,
    domain: app.domain,
    log_tail: logTail,
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

  recordDeploy(app.id, prev.image_tag, "success", "Rolled back");

  return {
    app_id: app.id,
    image_tag: prev.image_tag,
    container_id: run.containerId,
    container_name: containerName,
    domain: app.domain,
    log_tail: `Rolled back to ${prev.image_tag} (deploy #${prev.id})`,
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
