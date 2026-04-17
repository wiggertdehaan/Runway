import type { Readable } from "node:stream";
import { updateApp, type App } from "../db/apps.js";
import {
  buildImageFromTar,
  getContainerLogs,
  getContainerStatus,
  removeContainerByName,
  runContainer,
} from "./docker.js";
import { deleteAppRoute, writeAppRoute } from "./gateway.js";

/**
 * Docker image names and container names must be all lowercase.
 * nanoid may include uppercase letters, so normalize here. The
 * id is still random-unique; lowercasing it does not meaningfully
 * reduce collision resistance at our id length.
 */
function dockerSafeId(appId: string): string {
  return appId.toLowerCase().replace(/[^a-z0-9-]/g, "-");
}

export function appContainerName(appId: string): string {
  return `runway-app-${dockerSafeId(appId)}`;
}

export function appImageTag(appId: string): string {
  return `runway-app-${dockerSafeId(appId)}:latest`;
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

/**
 * Run a full deploy: build the uploaded tarball into an image,
 * replace the previous container, and (re)publish the Traefik
 * route file so the new container is reachable.
 */
export async function deployApp(input: DeployInput): Promise<DeployResult> {
  const { app, tar } = input;
  const imageTag = appImageTag(app.id);
  const containerName = appContainerName(app.id);

  updateApp(app.id, { status: "building" });

  const build = await buildImageFromTar(tar, { imageTag });

  updateApp(app.id, { status: "starting" });

  const run = await runContainer({
    containerName,
    imageTag,
    port: app.port,
    cpuLimit: app.cpu_limit,
    memoryLimit: app.memory_limit,
  });

  if (app.domain) {
    await writeAppRoute({
      appId: app.id,
      containerName,
      domain: app.domain,
      port: app.port,
    });
  }

  updateApp(app.id, {
    status: "running",
  });

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
