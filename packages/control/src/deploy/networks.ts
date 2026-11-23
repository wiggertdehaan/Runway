import { createHash } from "node:crypto";

/**
 * One Docker network per app (S04).
 *
 * Until 0.38.1 every app container joined the shared `runway-apps` network, so
 * a malicious app could reach every other app by container name and skip the
 * SSO / basic-auth that only lives in Traefik. Now each app gets its own
 * bridge network. Only the gateway (Traefik) is a member of more than one of
 * them, so it can route to every app while the apps cannot see each other.
 *
 * Docker already keeps separate bridge networks apart (its isolation chains),
 * and an app network contains nothing but the app and the gateway.
 *
 * Two things in here are not obvious:
 *
 *  - The bridge interface gets a fixed prefix (`rwa-` + 11 hex chars). The host
 *    egress rules (scripts/egress-rules.sh) match `-i rwa+`, so a network that
 *    is created later is covered without touching the firewall again.
 *  - Subnets are allocated from our own pool in small slices. Docker's default
 *    pools hand out a /16 per network and run dry after roughly 30 networks,
 *    which is far too few for a server with many apps.
 */

export const GATEWAY_CONTAINER = process.env.GATEWAY_CONTAINER || "runway-gateway";
/** Network every app used before per-app networks. Kept for rollback and for apps not yet redeployed. */
export const LEGACY_APPS_NETWORK = process.env.RUNWAY_NETWORK || "runway-apps";
export const NETWORK_ROLE_LABEL = "runway.role";
export const NETWORK_APP_LABEL = "runway.app";
export const APP_NETWORK_ROLE = "app-network";
export const BRIDGE_PREFIX = "rwa-";
export const DEFAULT_POOL = "10.250.0.0/16";
export const DEFAULT_SUBNET_PREFIX = 28;

/** `per-app` (default) or `shared` (the old behaviour, an emergency switch). */
export function networkMode(env: NodeJS.ProcessEnv = process.env): "per-app" | "shared" {
  return env.RUNWAY_APP_NETWORK_MODE === "shared" ? "shared" : "per-app";
}

/** `runway-app-foo` -> `runway-net-foo`. The container name is the app's identity here. */
export function networkNameForContainer(containerName: string): string {
  const rest = containerName.replace(/^runway-app-/, "");
  return `runway-net-${rest}`;
}

/** Linux interface names are 15 characters at most: `rwa-` + 11 hex chars of a hash of the network name. */
export function bridgeNameFor(networkName: string): string {
  return BRIDGE_PREFIX + createHash("sha256").update(networkName).digest("hex").slice(0, 11);
}

// ── IPv4 arithmetic (no dependencies) ─────────────────────────────────────

export interface Cidr {
  base: number;
  prefix: number;
}

export function ipToInt(ip: string): number {
  const parts = ip.split(".");
  if (parts.length !== 4) throw new Error(`Not an IPv4 address: ${ip}`);
  let n = 0;
  for (const p of parts) {
    if (!/^\d{1,3}$/.test(p) || Number(p) > 255) throw new Error(`Not an IPv4 address: ${ip}`);
    n = n * 256 + Number(p);
  }
  return n;
}

export function intToIp(n: number): string {
  return [n >>> 24, (n >>> 16) & 255, (n >>> 8) & 255, n & 255].join(".");
}

export function parseCidr(cidr: string): Cidr {
  const m = /^(\d{1,3}(?:\.\d{1,3}){3})\/(\d{1,2})$/.exec(cidr.trim());
  if (!m) throw new Error(`Not an IPv4 CIDR: ${cidr}`);
  const prefix = Number(m[2]);
  if (prefix < 0 || prefix > 32) throw new Error(`Bad prefix in ${cidr}`);
  const size = 2 ** (32 - prefix);
  const base = Math.floor(ipToInt(m[1]) / size) * size;
  return { base, prefix };
}

export function formatCidr(c: Cidr): string {
  return `${intToIp(c.base)}/${c.prefix}`;
}

export function cidrOverlaps(a: Cidr, b: Cidr): boolean {
  const aEnd = a.base + 2 ** (32 - a.prefix) - 1;
  const bEnd = b.base + 2 ** (32 - b.prefix) - 1;
  return a.base <= bEnd && b.base <= aEnd;
}

/**
 * First slice of `pool` (cut into /`prefix` pieces) that overlaps none of
 * `used`. Throws when the pool is full. `used` entries that are not IPv4 CIDRs
 * (IPv6 subnets, empty strings) are skipped.
 */
export function nextFreeSubnet(
  pool: string,
  prefix: number,
  used: string[]
): string {
  const p = parseCidr(pool);
  if (prefix < p.prefix || prefix > 30) {
    throw new Error(`Subnet size /${prefix} does not fit pool ${pool}`);
  }
  const taken: Cidr[] = [];
  for (const u of used) {
    try {
      taken.push(parseCidr(u));
    } catch {
      /* IPv6 or malformed: not ours to compare */
    }
  }
  const step = 2 ** (32 - prefix);
  const end = p.base + 2 ** (32 - p.prefix);
  for (let base = p.base; base < end; base += step) {
    const cand = { base, prefix };
    if (!taken.some((t) => cidrOverlaps(cand, t))) return formatCidr(cand);
  }
  throw new Error(
    `No free subnet left in ${pool} (/${prefix} slices). Widen RUNWAY_APP_NET_POOL.`
  );
}

// ── Docker side ────────────────────────────────────────────────────────

/** The part of dockerode that this file uses; a test double implements just this. */
export interface NetworkDocker {
  listNetworks(opts?: { filters?: Record<string, string[]> }): Promise<
    Array<{
      Id: string;
      Name: string;
      Labels?: Record<string, string> | null;
      IPAM?: { Config?: Array<{ Subnet?: string }> | null } | null;
    }>
  >;
  createNetwork(opts: Record<string, unknown>): Promise<unknown>;
  getNetwork(name: string): {
    inspect(): Promise<{
      Name?: string;
      Containers?: Record<string, { Name?: string }> | null;
      Labels?: Record<string, string> | null;
    }>;
    connect(opts: Record<string, unknown>): Promise<unknown>;
    disconnect(opts: Record<string, unknown>): Promise<unknown>;
    remove(): Promise<unknown>;
  };
  getContainer(name: string): {
    inspect(): Promise<{ NetworkSettings?: { Networks?: Record<string, unknown> | null } }>;
  };
}

function status(err: unknown): number | undefined {
  return (err as { statusCode?: number })?.statusCode;
}

/** One network creation at a time: the free-subnet search and the create must not interleave. */
let creating: Promise<unknown> = Promise.resolve();
function serialised<T>(fn: () => Promise<T>): Promise<T> {
  const run = creating.then(fn, fn);
  creating = run.catch(() => {});
  return run;
}

function subnetsOf(
  nets: Array<{ IPAM?: { Config?: Array<{ Subnet?: string }> | null } | null }>
): string[] {
  const out: string[] = [];
  for (const n of nets) for (const c of n.IPAM?.Config ?? []) if (c.Subnet) out.push(c.Subnet);
  return out;
}

/**
 * Make sure the app's network exists. Idempotent: an existing network is left
 * alone (its subnet never changes under a running app). Throws when the
 * network cannot be created, on purpose: falling back to the shared network
 * would quietly undo the isolation.
 */
export async function ensureAppNetwork(
  docker: NetworkDocker,
  networkName: string,
  appId?: string,
  env: NodeJS.ProcessEnv = process.env
): Promise<void> {
  const exists = async () => {
    try {
      await docker.getNetwork(networkName).inspect();
      return true;
    } catch (err) {
      if (status(err) === 404) return false;
      throw err;
    }
  };
  if (await exists()) return;

  await serialised(async () => {
    if (await exists()) return;
    const pool = env.RUNWAY_APP_NET_POOL || DEFAULT_POOL;
    const prefix = Number(env.RUNWAY_APP_NET_PREFIX || DEFAULT_SUBNET_PREFIX);
    const subnet = nextFreeSubnet(pool, prefix, subnetsOf(await docker.listNetworks()));
    try {
      await docker.createNetwork({
        Name: networkName,
        Driver: "bridge",
        CheckDuplicate: true,
        Labels: {
          [NETWORK_ROLE_LABEL]: APP_NETWORK_ROLE,
          ...(appId ? { [NETWORK_APP_LABEL]: appId } : {}),
        },
        Options: { "com.docker.network.bridge.name": bridgeNameFor(networkName) },
        IPAM: { Driver: "default", Config: [{ Subnet: subnet }] },
      });
    } catch (err) {
      if (status(err) === 409) return; // someone else created it a moment ago
      throw err;
    }
  });
}

/** Put the gateway on the app's network so it can route to it. Idempotent. */
export async function connectGateway(
  docker: NetworkDocker,
  networkName: string,
  gateway: string = GATEWAY_CONTAINER
): Promise<void> {
  try {
    await docker.getNetwork(networkName).connect({ Container: gateway });
  } catch (err) {
    const msg = String((err as Error)?.message ?? err);
    // Already a member: Docker answers 403 "endpoint with name ... already exists".
    if (status(err) === 403 && /already exists/i.test(msg)) return;
    throw err;
  }
}

/** Remove an app's network (after its container is gone). Never throws for "already gone" or "still in use". */
export async function removeAppNetwork(
  docker: NetworkDocker,
  networkName: string,
  gateway: string = GATEWAY_CONTAINER
): Promise<boolean> {
  const net = docker.getNetwork(networkName);
  try {
    await net.disconnect({ Container: gateway, Force: true });
  } catch (err) {
    if (![403, 404].includes(status(err) ?? 0)) throw err;
  }
  try {
    await net.remove();
    return true;
  } catch (err) {
    if ([404, 403, 409].includes(status(err) ?? 0)) return false;
    throw err;
  }
}

// ── Reconcile: keep the gateway attached to every app network ──────────────

export interface ReconcilePlan {
  /** App networks the gateway is not (or no longer) a member of. */
  connect: string[];
  /** App networks whose app no longer exists and that hold nothing but the gateway. */
  orphans: string[];
}

/**
 * Pure. `networks` are the app networks Docker has, `appIds` the apps in the
 * database, `gatewayOn` the network names the gateway is attached to, and
 * `occupants` how many containers other than the gateway sit on each network.
 */
export function planReconcile(input: {
  networks: Array<{ name: string; appId?: string }>;
  appIds: Set<string>;
  gatewayOn: Set<string>;
  occupants: Record<string, number>;
}): ReconcilePlan {
  const connect: string[] = [];
  const orphans: string[] = [];
  for (const n of input.networks) {
    const orphan = !!n.appId && !input.appIds.has(n.appId) && (input.occupants[n.name] ?? 0) === 0;
    if (orphan) orphans.push(n.name);
    else if (!input.gatewayOn.has(n.name)) connect.push(n.name);
  }
  return { connect, orphans };
}

export interface ReconcileResult extends ReconcilePlan {
  /** Containers still on the legacy shared network (apps not redeployed since the upgrade). */
  legacy: number;
  errors: string[];
}

/**
 * Recreating the gateway container (docker compose up after a change) drops
 * every network that was attached at runtime, so every route would answer 502
 * until something reattaches it. This runs at startup and every minute.
 */
export async function reconcileGatewayNetworks(
  docker: NetworkDocker,
  appIds: Set<string>,
  gateway: string = GATEWAY_CONTAINER
): Promise<ReconcileResult> {
  const errors: string[] = [];
  const nets = await docker.listNetworks({
    filters: { label: [`${NETWORK_ROLE_LABEL}=${APP_NETWORK_ROLE}`] },
  });

  let gatewayOn = new Set<string>();
  try {
    const info = await docker.getContainer(gateway).inspect();
    gatewayOn = new Set(Object.keys(info.NetworkSettings?.Networks ?? {}));
  } catch (err) {
    // No gateway (dev, or not started yet): nothing to attach.
    return { connect: [], orphans: [], legacy: 0, errors: [`gateway ${gateway}: ${String(err)}`] };
  }

  const occupants: Record<string, number> = {};
  for (const n of nets) {
    if (gatewayOn.has(n.Name) && appIds.has(n.Labels?.[NETWORK_APP_LABEL] ?? "")) continue;
    try {
      const info = await docker.getNetwork(n.Name).inspect();
      occupants[n.Name] = Object.values(info.Containers ?? {}).filter((c) => c.Name !== gateway).length;
    } catch {
      occupants[n.Name] = 1; // unknown: never treat as an orphan
    }
  }

  const plan = planReconcile({
    networks: nets.map((n) => ({ name: n.Name, appId: n.Labels?.[NETWORK_APP_LABEL] })),
    appIds,
    gatewayOn,
    occupants,
  });

  for (const name of plan.connect) {
    try {
      await connectGateway(docker, name, gateway);
    } catch (err) {
      errors.push(`connect ${name}: ${String(err)}`);
    }
  }
  for (const name of plan.orphans) {
    try {
      await removeAppNetwork(docker, name, gateway);
    } catch (err) {
      errors.push(`remove ${name}: ${String(err)}`);
    }
  }

  let legacy = 0;
  try {
    const info = await docker.getNetwork(LEGACY_APPS_NETWORK).inspect();
    legacy = Object.values(info.Containers ?? {}).filter(
      (c) => (c.Name ?? "").startsWith("runway-app-")
    ).length;
  } catch {
    /* no legacy network (fresh install): nothing to count */
  }
  return { ...plan, legacy, errors };
}

/** Startup run plus a minute tick. Logs only when something changed. */
export function startGatewayNetworkReconciler(deps: {
  docker: NetworkDocker;
  appIds: () => Set<string>;
  log?: (msg: string) => void;
  intervalMs?: number;
}): () => void {
  const log = deps.log ?? (() => {});
  let lastLegacy = -1;
  let running = false;
  const tick = async () => {
    if (running || networkMode() === "shared") return;
    running = true;
    try {
      const r = await reconcileGatewayNetworks(deps.docker, deps.appIds());
      if (r.connect.length) log(`Attached the gateway to ${r.connect.length} app network(s)`);
      if (r.orphans.length) log(`Removed ${r.orphans.length} unused app network(s)`);
      for (const e of r.errors) log(`Network reconcile: ${e}`);
      if (r.legacy !== lastLegacy) {
        lastLegacy = r.legacy;
        if (r.legacy > 0) {
          log(
            `${r.legacy} app container(s) are still on the shared ${LEGACY_APPS_NETWORK} network; each moves to its own network at its next deploy or rebuild`
          );
        }
      }
    } catch (err) {
      log(`Network reconcile failed: ${String(err)}`);
    } finally {
      running = false;
    }
  };
  void tick();
  const timer = setInterval(tick, deps.intervalMs ?? 60_000);
  timer.unref?.();
  return () => clearInterval(timer);
}
