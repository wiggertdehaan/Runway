/**
 * Container hardening for deployed apps (S08).
 *
 * One pure place that decides which Docker HostConfig options an app
 * container gets for capabilities, PIDs, swap, log rotation and a read-only
 * root filesystem, plus a validator that refuses any HostConfig that would
 * give an app access to the host. `runContainer` composes the final
 * HostConfig from these two functions and nothing else adds security options.
 *
 * Profiles:
 *   standard  drop ALL capabilities and add back a small set that ordinary
 *             images need (root entrypoints that chown a volume and then
 *             drop to a service user, e.g. the official nginx image).
 *   strict    drop ALL, add nothing back. For apps that already run as a
 *             non-root user, as the Runway Dockerfile templates do.
 *   relaxed   Docker's own capability defaults, no PID limit, no
 *             no-new-privileges, no swap rule, no read-only rootfs. Log
 *             rotation stays (it protects the disk, not the app). This is the
 *             escape hatch for an app that breaks under the other two.
 */

export type HardeningMode = "standard" | "strict" | "relaxed";

export const HARDENING_MODES: readonly HardeningMode[] = ["standard", "strict", "relaxed"];

export const DEFAULT_HARDENING_MODE: HardeningMode = "standard";

/**
 * Capabilities handed back after CapDrop ALL in the `standard` profile. All
 * of them are in Docker's own default set, so no app gets more than before;
 * the profile only removes the rest (NET_RAW, MKNOD, SETFCAP, SETPCAP,
 * SYS_CHROOT, AUDIT_WRITE, FSETID, KILL).
 *
 * NET_BIND_SERVICE is kept so a root process can still bind ports below 1024
 * on older Docker versions; recent ones already allow that for everyone
 * inside the container's network namespace.
 */
export const STANDARD_CAP_ADD: readonly string[] = [
  "CHOWN",
  "DAC_OVERRIDE",
  "FOWNER",
  "SETGID",
  "SETUID",
  "NET_BIND_SERVICE",
];

/**
 * The PID limit counts tasks, so threads too: a JVM or a Node app with a big
 * worker pool needs headroom. 512 is the value from the security review.
 */
export const DEFAULT_PIDS_LIMIT = 512;
export const MIN_PIDS_LIMIT = 64;
export const MAX_PIDS_LIMIT = 32768;

export const LOG_MAX_SIZE = "10m";
export const LOG_MAX_FILE = "3";

/** /tmp stays writable when the root filesystem is read-only. */
export const READONLY_TMPFS: Readonly<Record<string, string>> = {
  "/tmp": "rw,nosuid,nodev,size=64m",
};

export function parseHardeningMode(value: string | null | undefined): HardeningMode | null {
  const v = (value ?? "").trim().toLowerCase();
  return (HARDENING_MODES as readonly string[]).includes(v) ? (v as HardeningMode) : null;
}

export type HardeningSource = "emergency-brake" | "app" | "instance" | "default";

export interface ResolvedHardening {
  mode: HardeningMode;
  source: HardeningSource;
}

/**
 * Which profile applies to an app.
 *
 *   1. RUNWAY_HARDENING=relaxed on the control container is an emergency
 *      brake: it wins over everything, including a per-app "strict".
 *   2. An administrator's per-app profile.
 *   3. RUNWAY_HARDENING=standard|strict as the instance default.
 *   4. standard.
 *
 * An unknown value (a typo) is ignored rather than guessed at, so a typo
 * never turns hardening off.
 */
export function resolveHardening(
  appProfile: string | null | undefined,
  env: Record<string, string | undefined> = process.env
): ResolvedHardening {
  const instance = parseHardeningMode(env.RUNWAY_HARDENING);
  if (instance === "relaxed") return { mode: "relaxed", source: "emergency-brake" };
  const perApp = parseHardeningMode(appProfile);
  if (perApp) return { mode: perApp, source: "app" };
  if (instance) return { mode: instance, source: "instance" };
  return { mode: DEFAULT_HARDENING_MODE, source: "default" };
}

/** RUNWAY_PIDS_LIMIT, clamped to [MIN, MAX]; the default when unset or invalid. */
export function pidsLimitFromEnv(env: Record<string, string | undefined> = process.env): number {
  const n = parseInt(env.RUNWAY_PIDS_LIMIT ?? "", 10);
  if (!Number.isFinite(n)) return DEFAULT_PIDS_LIMIT;
  return Math.min(Math.max(n, MIN_PIDS_LIMIT), MAX_PIDS_LIMIT);
}

/** The slice of Docker's HostConfig this module owns. */
export interface HardeningHostConfig {
  CapDrop?: string[];
  CapAdd?: string[];
  SecurityOpt?: string[];
  PidsLimit?: number;
  MemorySwap?: number;
  LogConfig: { Type: string; Config: Record<string, string> };
  ReadonlyRootfs?: boolean;
  Tmpfs?: Record<string, string>;
}

export interface HardeningInput {
  mode: HardeningMode;
  /** Opt-in per app. Ignored in `relaxed`. */
  readonlyRootfs?: boolean;
  /** Memory limit in bytes, when the app has one. */
  memoryBytes?: number;
  pidsLimit?: number;
}

/**
 * The HostConfig fields for a profile. Never sets Privileged, a host
 * namespace, a device or a bind mount; `assertSafeHostConfig` enforces that
 * on the final object.
 */
export function buildHardening(input: HardeningInput): HardeningHostConfig {
  const logConfig = {
    Type: "json-file",
    Config: { "max-size": LOG_MAX_SIZE, "max-file": LOG_MAX_FILE },
  };
  if (input.mode === "relaxed") return { LogConfig: logConfig };

  const out: HardeningHostConfig = {
    CapDrop: ["ALL"],
    SecurityOpt: ["no-new-privileges:true"],
    PidsLimit: input.pidsLimit ?? DEFAULT_PIDS_LIMIT,
    LogConfig: logConfig,
  };
  if (input.mode === "standard") out.CapAdd = [...STANDARD_CAP_ADD];
  // Memory + swap equal means no swap: a runaway app is killed at its limit
  // instead of swapping the whole host to a crawl.
  if (input.memoryBytes && input.memoryBytes > 0) out.MemorySwap = input.memoryBytes;
  if (input.readonlyRootfs) {
    out.ReadonlyRootfs = true;
    out.Tmpfs = { ...READONLY_TMPFS };
  }
  return out;
}

const ALLOWED_CAP_ADD = new Set(STANDARD_CAP_ADD);

/**
 * Refuse a HostConfig that gives an app container access to the host.
 * Defence in depth on top of the validation done on the way in: whatever
 * ends up in `createContainer` for an app passes through here first.
 * Returns nothing; throws an Error naming the first problem.
 */
export function assertSafeHostConfig(hc: Record<string, unknown>): void {
  const bad = (what: string): never => {
    throw new Error(`Refusing to start an app container: ${what}`);
  };

  if (hc.Privileged) bad("Privileged is set");
  for (const key of ["PidMode", "IpcMode", "UTSMode", "UsernsMode", "CgroupnsMode"]) {
    if (String(hc[key] ?? "").toLowerCase() === "host") bad(`${key} is host`);
  }
  const net = String(hc.NetworkMode ?? "");
  if (net === "host" || net.startsWith("container:")) bad(`NetworkMode is ${net}`);

  const devices = hc.Devices as unknown[] | undefined;
  if (devices && devices.length > 0) bad("a device is mapped");
  const mounts = hc.Mounts as unknown[] | undefined;
  if (mounts && mounts.length > 0) bad("Mounts is set (only named volumes are allowed)");

  for (const bind of (hc.Binds as string[] | undefined) ?? []) {
    const source = String(bind).split(":")[0] ?? "";
    // A named volume has no slash in its source. An absolute or relative
    // path is a host path; the socket is a host path too.
    if (source.includes("/") || source.startsWith(".") || source === "") {
      bad(`bind mount ${source || "(empty)"} is a host path`);
    }
  }

  for (const cap of (hc.CapAdd as string[] | undefined) ?? []) {
    if (!ALLOWED_CAP_ADD.has(String(cap).toUpperCase())) bad(`capability ${cap} is not allowed`);
  }
  for (const opt of (hc.SecurityOpt as string[] | undefined) ?? []) {
    if (/unconfined|systempaths/i.test(String(opt))) bad(`security option ${opt} is not allowed`);
  }
}
