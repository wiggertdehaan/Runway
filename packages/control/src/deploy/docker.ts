import Docker from "dockerode";
import { execFileSync } from "node:child_process";
import { mkdtemp, rm, writeFile, unlink } from "node:fs/promises";
import { basename } from "node:path";
import { createReadStream } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Readable } from "node:stream";
import { extractTarSafe, tarLimits } from "./safe-tar.js";
import {
  assertSafeHostConfig,
  buildHardening,
  pidsLimitFromEnv,
  resolveHardening,
} from "./hardening.js";
import {
  LEGACY_APPS_NETWORK,
  connectGateway,
  ensureAppNetwork,
  networkMode,
  networkNameForContainer,
  type NetworkDocker,
} from "./networks.js";

// Every app gets its own network (deploy/networks.ts) and Traefik joins each
// of them, so apps cannot reach each other or the control plane. The shared
// `runway-apps` network is what every app used before; it is only used when
// RUNWAY_APP_NETWORK_MODE=shared (an emergency switch) and for apps that have
// not been redeployed since the upgrade.
const BUILDKIT_CONTAINER = process.env.BUILDKIT_CONTAINER || "runway-buildkit";

export const docker = new Docker({ socketPath: "/var/run/docker.sock" });

/** dockerode, seen through the part of its API that deploy/networks.ts uses. */
function networkApi(): NetworkDocker {
  return docker as unknown as NetworkDocker;
}

export interface BuildOptions {
  imageTag: string;
  dockerfile?: string;
  /**
   * Bypass the BuildKit layer cache entirely (`buildctl --no-cache`).
   * Used by rebuilds so a cached `apt-get upgrade` layer can't hand us
   * back the same vulnerable packages. The base image tag is still
   * resolved against the registry on every build (a newer digest is
   * picked up), but already-downloaded layers of an unchanged digest
   * are reused, which is correct and shows as `CACHED` on the FROM step.
   */
  noCache?: boolean;
  /**
   * Replacement Dockerfile text, written into the extracted build
   * context only (the stored source tar is never modified). Used by
   * rebuilds to bump exact base-image patch pins.
   */
  dockerfileOverride?: string;
  /** `--build-arg` values (ARG-driven FROM refs). */
  buildArgs?: Record<string, string>;
}

export interface BuildResult {
  imageTag: string;
  log: string;
}

/**
 * Build a Docker image via the isolated BuildKit service. The build
 * context (tar) is extracted to a temp directory, buildctl sends it
 * to BuildKit over TCP, and the resulting image is exported as a
 * Docker tarball which we load into the local Docker daemon.
 *
 * RUN steps in user Dockerfiles execute inside BuildKit's containerd
 * sandbox — they have no access to the Docker socket or the host.
 */
/**
 * Build a Docker image via the isolated BuildKit container. The build
 * context (tar) is written to a shared volume (/exchange), then
 * buildctl is invoked inside the BuildKit container via docker exec.
 * The resulting image tarball is written back to /exchange and loaded
 * into the local Docker daemon.
 *
 * RUN steps in user Dockerfiles execute inside BuildKit's containerd
 * sandbox — they have no access to the Docker socket or the host.
 */
export async function buildImageFromTar(
  tarStream: Readable | Buffer,
  opts: BuildOptions
): Promise<BuildResult> {
  const contextBuf = Buffer.isBuffer(tarStream)
    ? tarStream
    : await streamToBuffer(tarStream);

  const buildId = `build-${Date.now()}`;
  const exchangeCtx = `/exchange/${buildId}-ctx`;
  const exchangeOut = `/exchange/${buildId}-out.tar`;
  const localOut = `/exchange/${buildId}-out.tar`;

  try {
    // Write tar to shared volume and extract
    const localCtxTar = `/exchange/${buildId}-ctx.tar`;
    await writeFile(localCtxTar, contextBuf);
    // S06: in-process, async, entry-checked unpack (no shell, no root-owned
    // files from the archive). The tar was already checked at upload; this
    // also covers stored sources and patched rebuild tars.
    await extractTarSafe(localCtxTar, exchangeCtx, tarLimits(contextBuf.length));
    await unlink(localCtxTar);
    if (opts.dockerfileOverride !== undefined) {
      // Fresh mtime on purpose: BuildKit's incremental context sync
      // compares size+mtime, and a same-length tag bump must not be
      // mistaken for "unchanged".
      await writeFile(
        `${exchangeCtx}/${opts.dockerfile ?? "Dockerfile"}`,
        opts.dockerfileOverride
      );
    }

    const log = await runBuildctlViaExec(opts.imageTag, exchangeCtx, exchangeOut, opts.dockerfile, opts.noCache, opts.buildArgs);

    await loadImage(localOut);

    return { imageTag: opts.imageTag, log };
  } finally {
    await rm(exchangeCtx, { recursive: true, force: true }).catch(() => {});
    await rm(exchangeOut, { force: true }).catch(() => {});
    await rm(`${exchangeCtx}.tar`, { force: true }).catch(() => {});
  }
}

/**
 * Run `buildctl prune` inside the BuildKit container to evict cache
 * blobs older than the given duration (Go duration syntax, e.g. "168h"
 * for one week). Returns a short summary line for logs.
 *
 * Best-effort: callers should swallow failures. Pruning is invoked from
 * a periodic timer; a flake on one run should not break later runs.
 */
export async function pruneBuildCache(
  keepDuration: string = "168h"
): Promise<string> {
  const cmd = ["buildctl", "prune", "--keep-duration", keepDuration];
  const container = docker.getContainer(BUILDKIT_CONTAINER);
  const exec = await container.exec({
    Cmd: cmd,
    AttachStdout: true,
    AttachStderr: true,
  });
  return new Promise((resolve, reject) => {
    exec.start({ hijack: true }, (err: any, stream: any) => {
      if (err) return reject(new Error(`buildctl prune failed: ${err.message}`));
      const chunks: Buffer[] = [];
      stream.on("data", (chunk: Buffer) => chunks.push(chunk));
      stream.on("end", async () => {
        const log = stripDockerLogHeaders(Buffer.concat(chunks));
        const info = await exec.inspect();
        if (info.ExitCode !== 0) {
          return reject(
            new Error(`buildctl prune exit ${info.ExitCode}: ${log.slice(-200)}`)
          );
        }
        const lastLine = log
          .split("\n")
          .filter((l) => l.trim().length > 0)
          .pop();
        resolve(lastLine ?? "prune completed");
      });
      stream.on("error", (e: Error) => reject(e));
    });
  });
}

async function runBuildctlViaExec(
  imageTag: string,
  contextDir: string,
  outputPath: string,
  dockerfile?: string,
  noCache?: boolean,
  buildArgs?: Record<string, string>
): Promise<string> {
  const cmd = buildctlArgs({ imageTag, contextDir, outputPath, dockerfile, noCache, buildArgs });
  const container = docker.getContainer(BUILDKIT_CONTAINER);
  const exec = await container.exec({
    Cmd: cmd,
    AttachStdout: true,
    AttachStderr: true,
  });
  return runBuildExec(exec);
}

/** Pure: the buildctl argv for one build. Exported for tests. */
export function buildctlArgs(o: {
  imageTag: string;
  contextDir: string;
  outputPath: string;
  dockerfile?: string;
  noCache?: boolean;
  buildArgs?: Record<string, string>;
}): string[] {
  return [
    "buildctl", "build",
    "--frontend", "dockerfile.v0",
    ...(o.noCache ? ["--no-cache"] : []),
    "--local", `context=${o.contextDir}`,
    "--local", `dockerfile=${o.contextDir}`,
    ...(o.dockerfile ? ["--opt", `filename=${o.dockerfile}`] : []),
    ...Object.entries(o.buildArgs ?? {})
      .sort(([a], [b]) => a.localeCompare(b))
      .flatMap(([k, v]) => ["--opt", `build-arg:${k}=${v}`]),
    "--output", `type=docker,name=${o.imageTag},dest=${o.outputPath}`,
  ];
}

async function runBuildExec(exec: Docker.Exec): Promise<string> {
  return new Promise((resolve, reject) => {
    exec.start({ hijack: true }, (err: any, stream: any) => {
      if (err) return reject(new Error(`Build exec failed: ${err.message}`));

      const chunks: Buffer[] = [];
      stream.on("data", (chunk: Buffer) => chunks.push(chunk));
      stream.on("end", async () => {
        const raw = Buffer.concat(chunks);
        const log = stripDockerLogHeaders(raw);

        const info = await exec.inspect();
        if (info.ExitCode !== 0) {
          return reject(
            Object.assign(new Error(`Build failed (exit ${info.ExitCode})`), { log })
          );
        }
        resolve(log);
      });
      stream.on("error", (e: Error) => reject(e));
    });
  });
}

function loadImage(tarPath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const stream = createReadStream(tarPath);
    docker.loadImage(stream, {}, (err: any, output: any) => {
      if (err) return reject(new Error(`Failed to load image: ${err.message}`));
      if (output) {
        output.on("data", () => {});
        output.on("end", () => resolve());
        output.on("error", (e: Error) => reject(e));
      } else {
        resolve();
      }
    });
  });
}

/**
 * Read one file out of an image without running it: create a container
 * (never started), take the file as a tar archive, remove the container.
 * Used to lift a regenerated lockfile out of a throwaway build.
 */
export async function readFileFromImage(
  imageTag: string,
  path: string,
  maxBytes = 20 * 1024 * 1024
): Promise<Buffer> {
  const container = await docker.createContainer({
    Image: imageTag,
    Cmd: ["/runway-never-started"],
    NetworkDisabled: true,
  });
  const dir = await mkdtemp(join(tmpdir(), "runway-img-"));
  try {
    const stream = (await container.getArchive({ path })) as unknown as Readable;
    const archive = await new Promise<Buffer>((resolve, reject) => {
      const chunks: Buffer[] = [];
      let size = 0;
      stream.on("data", (chunk) => {
        size += chunk.length;
        if (size > maxBytes * 2) {
          stream.destroy();
          return reject(new Error(`${path} in ${imageTag} is too large`));
        }
        chunks.push(Buffer.from(chunk));
      });
      stream.on("end", () => resolve(Buffer.concat(chunks)));
      stream.on("error", reject);
    });
    const tarPath = join(dir, "file.tar");
    await writeFile(tarPath, archive);
    return execFileSync("tar", ["-xOf", tarPath, basename(path)], {
      maxBuffer: maxBytes,
      stdio: ["ignore", "pipe", "ignore"],
    });
  } finally {
    await container.remove({ force: true }).catch(() => {});
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

function streamToBuffer(stream: Readable): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    stream.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
    stream.on("end", () => resolve(Buffer.concat(chunks)));
    stream.on("error", reject);
  });
}

export interface RunOptions {
  containerName: string;
  imageTag: string;
  port: number;
  env?: Record<string, string>;
  volumes?: string[];
  cpuLimit?: string;
  memoryLimit?: string;
  healthCheckPath?: string | null;
  /** Owner of the container, stored as a label on its network. */
  appId?: string;
  /** Override the per-app network name (tests). */
  network?: string;
  /** Administrator's per-app hardening profile (apps.hardening_profile); null = instance default. */
  hardening?: string | null;
  /** Opt-in read-only root filesystem (apps.readonly_rootfs). */
  readonlyRootfs?: boolean;
}

export interface RunResult {
  containerId: string;
}

/**
 * Create and start a container, replacing any existing container with
 * the same name. Joins the app's own network, to which the gateway is
 * attached first so Traefik can reach it by container name from the moment
 * the container starts.
 */
export async function runContainer(opts: RunOptions): Promise<RunResult> {
  // Stop + remove any existing container with this name
  await removeContainerByName(opts.containerName);

  const envList = Object.entries(opts.env ?? {}).map(([k, v]) => `${k}=${v}`);

  const memory = parseMemoryLimit(opts.memoryLimit);
  const nanoCpus = parseCpuLimit(opts.cpuLimit);

  const healthcheck = opts.healthCheckPath
    ? {
        Healthcheck: {
          Test: [
            "CMD",
            "wget",
            "-qO-",
            `http://127.0.0.1:${opts.port}${opts.healthCheckPath}`,
          ],
          Interval: 30_000_000_000,
          Timeout: 5_000_000_000,
          Retries: 3,
          StartPeriod: 10_000_000_000,
        },
      }
    : {};

  let network = LEGACY_APPS_NETWORK;
  if (networkMode() === "per-app") {
    network = opts.network ?? networkNameForContainer(opts.containerName);
    // Failing here fails the deploy: falling back to the shared network
    // would quietly undo the isolation.
    await ensureAppNetwork(networkApi(), network, opts.appId);
    await connectGateway(networkApi(), network);
  }

  // Capabilities, PID limit, swap, log rotation and read-only rootfs come
  // from one pure helper (S08); nothing else adds security options here.
  const hardening = buildHardening({
    mode: resolveHardening(opts.hardening).mode,
    readonlyRootfs: opts.readonlyRootfs,
    memoryBytes: memory,
    pidsLimit: pidsLimitFromEnv(),
  });

  const hostConfig = {
    RestartPolicy: { Name: "unless-stopped" },
    NetworkMode: network,
    ...(opts.volumes?.length ? { Binds: opts.volumes } : {}),
    ...(memory ? { Memory: memory } : {}),
    ...(nanoCpus ? { NanoCpus: nanoCpus } : {}),
    ...hardening,
  };
  // Last line of defence: an app container never gets Privileged, a host
  // namespace, a device, an unusual capability or a host path as a mount.
  assertSafeHostConfig(hostConfig);

  const container = await docker.createContainer({
    name: opts.containerName,
    Image: opts.imageTag,
    Env: envList,
    ExposedPorts: { [`${opts.port}/tcp`]: {} },
    ...healthcheck,
    HostConfig: hostConfig,
  });

  await container.start();
  return { containerId: container.id };
}

/**
 * Delete an image by tag. Tolerates 404 (already gone) and 409
 * (still in use by a container), since pruning should never fail
 * a deploy. Returns whether the image was actually removed.
 */
export async function removeImageByTag(tag: string): Promise<boolean> {
  try {
    await docker.getImage(tag).remove({ force: false });
    return true;
  } catch (err: any) {
    if (err.statusCode === 404 || err.statusCode === 409) return false;
    throw err;
  }
}

export async function removeContainerByName(name: string): Promise<void> {
  try {
    const existing = docker.getContainer(name);
    await existing.inspect();
    try {
      await existing.stop({ t: 10 });
    } catch {
      /* already stopped */
    }
    await existing.remove({ force: true });
  } catch (err: any) {
    if (err.statusCode !== 404) throw err;
  }
}

/**
 * Stop a container but keep it (and its named volumes). Unlike
 * removeContainerByName, nothing is deleted, and a stopped container with
 * restart policy `unless-stopped` stays stopped across daemon restarts.
 * Tolerates "already stopped" and "no such container".
 */
export async function stopContainerByName(name: string): Promise<void> {
  try {
    await docker.getContainer(name).stop({ t: 10 });
  } catch (err: any) {
    if (err.statusCode !== 304 && err.statusCode !== 404) throw err;
  }
}

export interface ContainerStatus {
  exists: boolean;
  state?: string;
  status?: string;
  health?: string;
  started_at?: string;
  finished_at?: string;
  exit_code?: number;
}

export async function getContainerStatus(
  name: string
): Promise<ContainerStatus> {
  try {
    const info = await docker.getContainer(name).inspect();
    return {
      exists: true,
      state: info.State.Status,
      status: info.State.Status,
      health: (info.State as any).Health?.Status ?? undefined,
      started_at: info.State.StartedAt,
      finished_at: info.State.FinishedAt,
      exit_code: info.State.ExitCode,
    };
  } catch (err: any) {
    if (err.statusCode === 404) return { exists: false };
    throw err;
  }
}

export async function getContainerLogs(
  name: string,
  tail = 200
): Promise<string> {
  try {
    const container = docker.getContainer(name);
    const buf = (await container.logs({
      stdout: true,
      stderr: true,
      tail,
      timestamps: false,
    })) as unknown as Buffer;
    return stripDockerLogHeaders(buf);
  } catch (err: any) {
    if (err.statusCode === 404) return "";
    throw err;
  }
}

/**
 * Docker's multiplexed log stream prepends an 8-byte header to each
 * chunk (stream type + length). Strip it to get plain text.
 */
function stripDockerLogHeaders(buf: Buffer): string {
  const out: string[] = [];
  let offset = 0;
  while (offset + 8 <= buf.length) {
    const size = buf.readUInt32BE(offset + 4);
    const start = offset + 8;
    const end = start + size;
    if (end > buf.length) break;
    out.push(buf.subarray(start, end).toString("utf8"));
    offset = end;
  }
  // Fall back to raw decode if parsing failed (single-stream logs)
  return out.length > 0 ? out.join("") : buf.toString("utf8");
}

function parseCpuLimit(limit?: string): number | undefined {
  if (!limit) return undefined;
  const n = parseFloat(limit);
  if (Number.isNaN(n) || n <= 0) return undefined;
  return Math.round(n * 1e9); // Docker NanoCpus = cpus * 1e9
}

function parseMemoryLimit(limit?: string): number | undefined {
  if (!limit) return undefined;
  const match = limit
    .trim()
    .toLowerCase()
    .match(/^(\d+(?:\.\d+)?)\s*(b|k|kb|m|mb|g|gb)?$/);
  if (!match) return undefined;
  const n = parseFloat(match[1]!);
  const unit = match[2] ?? "b";
  const multipliers: Record<string, number> = {
    b: 1,
    k: 1024,
    kb: 1024,
    m: 1024 * 1024,
    mb: 1024 * 1024,
    g: 1024 * 1024 * 1024,
    gb: 1024 * 1024 * 1024,
  };
  return Math.round(n * (multipliers[unit] ?? 1));
}
