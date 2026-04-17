import Docker from "dockerode";
import type { Readable } from "node:stream";

const RUNWAY_NETWORK = process.env.RUNWAY_NETWORK || "runway-internal";

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
 * Build a Docker image from a tar stream. Returns when the build
 * finishes (success or failure). Throws on build failure with the
 * combined build log attached.
 */
export async function buildImageFromTar(
  tarStream: Readable | Buffer,
  opts: BuildOptions
): Promise<BuildResult> {
  const stream = (await docker.buildImage(tarStream as any, {
    t: opts.imageTag,
    dockerfile: opts.dockerfile ?? "Dockerfile",
    rm: true,
    forcerm: true,
  })) as NodeJS.ReadableStream;

  return new Promise((resolve, reject) => {
    const logLines: string[] = [];

    docker.modem.followProgress(
      stream,
      (err, output) => {
        if (err) {
          return reject(
            Object.assign(new Error(`Build failed: ${err.message}`), {
              log: logLines.join("\n"),
            })
          );
        }

        // Look for explicit error events in the output
        const lastError = output?.find((line: any) => line?.errorDetail);
        if (lastError) {
          return reject(
            Object.assign(
              new Error(
                `Build failed: ${lastError.errorDetail?.message ?? lastError.error}`
              ),
              { log: logLines.join("\n") }
            )
          );
        }

        resolve({ imageTag: opts.imageTag, log: logLines.join("\n") });
      },
      (event: any) => {
        if (event?.stream) {
          logLines.push(String(event.stream).replace(/\n$/, ""));
        } else if (event?.error) {
          logLines.push(`ERROR: ${event.error}`);
        }
      }
    );
  });
}

export interface RunOptions {
  containerName: string;
  imageTag: string;
  port: number;
  env?: Record<string, string>;
  cpuLimit?: string;
  memoryLimit?: string;
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

  const container = await docker.createContainer({
    name: opts.containerName,
    Image: opts.imageTag,
    Env: envList,
    ExposedPorts: { [`${opts.port}/tcp`]: {} },
    HostConfig: {
      RestartPolicy: { Name: "unless-stopped" },
      NetworkMode: RUNWAY_NETWORK,
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
