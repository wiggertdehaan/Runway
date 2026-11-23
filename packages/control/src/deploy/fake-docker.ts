import type { NetworkDocker } from "./networks.js";

/**
 * In-memory stand-in for the network part of the Docker daemon, used by the
 * tests of deploy/networks.ts and docker.ts. It behaves like Docker where the
 * code under test depends on it: a missing network is a 404, creating one
 * twice is a 409, connecting a container that is already a member is a 403
 * "already exists", and a network that still has a member other than the
 * gateway cannot be removed (409).
 */
export interface FakeNet {
  Id: string;
  Name: string;
  Labels: Record<string, string>;
  Subnet?: string;
  BridgeName?: string;
  members: Set<string>;
}

function dockerError(statusCode: number, message: string): Error {
  return Object.assign(new Error(message), { statusCode });
}

export class FakeDocker implements NetworkDocker {
  nets = new Map<string, FakeNet>();
  /** container name -> networks it is on */
  containers = new Map<string, Set<string>>();
  /** every mutating call, in order, as "verb name" */
  calls: string[] = [];
  failCreate: Error | null = null;
  private seq = 0;

  constructor(opts: { gateway?: string | null } = {}) {
    const gateway = opts.gateway === undefined ? "runway-gateway" : opts.gateway;
    this.addNet("runway-internal", "172.19.0.0/16");
    this.addNet("runway-apps", "172.18.0.0/16");
    if (gateway) {
      this.containers.set(gateway, new Set());
      this.join("runway-internal", gateway);
      this.join("runway-apps", gateway);
    }
  }

  addNet(name: string, subnet: string, labels: Record<string, string> = {}): FakeNet {
    const net: FakeNet = {
      Id: `id${++this.seq}`.padEnd(12, "0"),
      Name: name,
      Labels: labels,
      Subnet: subnet,
      members: new Set(),
    };
    this.nets.set(name, net);
    return net;
  }

  /** Put a container (creating it if needed) on a network. */
  join(net: string, container: string): void {
    this.nets.get(net)!.members.add(container);
    if (!this.containers.has(container)) this.containers.set(container, new Set());
    this.containers.get(container)!.add(net);
  }

  /** Simulate `docker compose up` recreating a container: it comes back on its compose networks only. */
  recreate(container: string, composeNets: string[]): void {
    for (const n of this.containers.get(container) ?? []) this.nets.get(n)?.members.delete(container);
    this.containers.set(container, new Set());
    for (const n of composeNets) this.join(n, container);
  }

  appNetworks(): FakeNet[] {
    return [...this.nets.values()].filter((n) => n.Labels["runway.role"] === "app-network");
  }

  // ── NetworkDocker ──

  async listNetworks(opts?: { filters?: Record<string, string[]> }) {
    const wanted = opts?.filters?.label ?? [];
    return [...this.nets.values()]
      .filter((n) =>
        wanted.every((w) => {
          const [k, v] = w.split("=");
          return v === undefined ? k in n.Labels : n.Labels[k] === v;
        })
      )
      .map((n) => ({
        Id: n.Id,
        Name: n.Name,
        Labels: n.Labels,
        IPAM: { Config: n.Subnet ? [{ Subnet: n.Subnet }] : [] },
      }));
  }

  async createNetwork(opts: Record<string, unknown>) {
    this.calls.push(`create ${opts.Name}`);
    if (this.failCreate) throw this.failCreate;
    const name = String(opts.Name);
    if (this.nets.has(name)) throw dockerError(409, "network with name already exists");
    const ipam = opts.IPAM as { Config?: Array<{ Subnet?: string }> } | undefined;
    const net = this.addNet(name, ipam?.Config?.[0]?.Subnet ?? "", (opts.Labels as Record<string, string>) ?? {});
    net.BridgeName = (opts.Options as Record<string, string> | undefined)?.["com.docker.network.bridge.name"];
    return {};
  }

  getNetwork(name: string) {
    const self = this;
    const need = () => {
      const n = self.nets.get(name);
      if (!n) throw dockerError(404, `network ${name} not found`);
      return n;
    };
    return {
      async inspect() {
        const n = need();
        const Containers: Record<string, { Name?: string }> = {};
        for (const c of n.members) Containers[`cid-${c}`] = { Name: c };
        return { Name: n.Name, Labels: n.Labels, Containers };
      },
      async connect(opts: Record<string, unknown>) {
        const n = need();
        const c = String(opts.Container);
        self.calls.push(`connect ${name} ${c}`);
        if (!self.containers.has(c)) throw dockerError(404, `container ${c} not found`);
        if (n.members.has(c)) throw dockerError(403, `endpoint with name ${c} already exists in network ${name}`);
        self.join(name, c);
        return {};
      },
      async disconnect(opts: Record<string, unknown>) {
        const n = need();
        const c = String(opts.Container);
        self.calls.push(`disconnect ${name} ${c}`);
        if (!n.members.delete(c)) throw dockerError(403, `container ${c} is not connected to the network`);
        self.containers.get(c)?.delete(name);
        return {};
      },
      async remove() {
        const n = need();
        self.calls.push(`remove ${name}`);
        if (n.members.size > 0) throw dockerError(403, `network ${name} has active endpoints`);
        self.nets.delete(name);
        return {};
      },
    };
  }

  getContainer(name: string) {
    const self = this;
    return {
      async inspect() {
        const nets = self.containers.get(name);
        if (!nets) throw dockerError(404, `no such container: ${name}`);
        return { NetworkSettings: { Networks: Object.fromEntries([...nets].map((n) => [n, {}])) } };
      },
    };
  }
}
