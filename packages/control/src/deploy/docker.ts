import Docker from "dockerode";
import { execFileSync } from "node:child_process";
import { mkdtemp, rm, writeFile, unlink } from "node:fs/promises";
import { createReadStream } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Readable } from "node:stream";

const RUNWAY_NETWORK = process.env.RUNWAY_NETWORK || "runway-internal";
const BUILDKIT_CONTAINER = process.env.BUILDKIT_CONTAINER || "runway-buildkit";

export const docker = new Docker({ socketPath: "/var/run/docker.sock" });

export interface BuildOptions {
  imageTag: string;
  dockerfile?: string;
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
    execFileSync("sh", ["-c", `mkdir -p ${exchangeCtx} && tar xf ${localCtxTar} -C ${exchangeCtx}`]);
    await unlink(localCtxTar);

    const log = await runBuildctlViaExec(opts.imageTag, exchangeCtx, exchangeOut, opts.dockerfile);

    await loadImage(localOut);

    return { imageTag: opts.imageTag, log };
  } finally {
    execFileSync("sh", ["-c", `rm -rf ${exchangeCtx} ${exchangeOut}`], { stdio: "ignore" });
  }
}

async function runBuildctlViaExec(
  imageTag: string,
  contextDir: string,
  outputPath: string,
  dockerfile?: string
): Promise<string> {
  const cmd = [
    "buildctl", "build",
    "--frontend", "dockerfile.v0",
    "--local", `context=${contextDir}`,
    "--local", `dockerfile=${contextDir}`,
    ...(dockerfile ? ["--opt", `filename=${dockerfile}`] : []),
    "--output", `type=docker,name=${imageTag},dest=${outputPath}`,
  ];

  const container = docker.getContainer(BUILDKIT_CONTAINER);
  const exec = await container.exec({
    Cmd: cmd,
    AttachStdout: true,
    AttachStderr: true,
  });

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
}

export interface RunResult {
  containerId: string;
}

/**
 * Create and start a container, replacing any existing container with
 * the same name. Joins the runway-internal network so Traefik can
 * reach it by name.
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
            `http://localhost:${opts.port}${opts.healthCheckPath}`,
          ],
          Interval: 30_000_000_000,
          Timeout: 5_000_000_000,
          Retries: 3,
          StartPeriod: 10_000_000_000,
        },
      }
    : {};

  const container = await docker.createContainer({
    name: opts.containerName,
    Image: opts.imageTag,
    Env: envList,
    ExposedPorts: { [`${opts.port}/tcp`]: {} },
    ...healthcheck,
    HostConfig: {
      RestartPolicy: { Name: "unless-stopped" },
      NetworkMode: RUNWAY_NETWORK,
      ...(opts.volumes?.length ? { Binds: opts.volumes } : {}),
      ...(memory ? { Memory: memory } : {}),
      ...(nanoCpus ? { NanoCpus: nanoCpus } : {}),
    },
  });

  await container.start();
  return { containerId: container.id };
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
