import { describe, it, expect, vi } from "vitest";
import {
  APP_NETWORK_ROLE,
  DEFAULT_POOL,
  bridgeNameFor,
  cidrOverlaps,
  connectGateway,
  ensureAppNetwork,
  formatCidr,
  intToIp,
  ipToInt,
  networkMode,
  networkNameForContainer,
  nextFreeSubnet,
  parseCidr,
  planReconcile,
  reconcileGatewayNetworks,
  removeAppNetwork,
  startGatewayNetworkReconciler,
} from "./networks.js";
import { FakeDocker } from "./fake-docker.js";

describe("names", () => {
  it("derives the network from the container name", () => {
    expect(networkNameForContainer("runway-app-abc123")).toBe("runway-net-abc123");
    expect(networkNameForContainer("other")).toBe("runway-net-other");
  });

  it("gives a bridge interface that Linux accepts and the firewall prefix matches", () => {
    const b = bridgeNameFor("runway-net-abc123");
    expect(b.startsWith("rwa-")).toBe(true);
    expect(b.length).toBeLessThanOrEqual(15); // IFNAMSIZ is 16 including the NUL
    expect(b).toMatch(/^[a-z0-9-]+$/);
  });

  it("is stable per network and different between networks", () => {
    expect(bridgeNameFor("runway-net-a")).toBe(bridgeNameFor("runway-net-a"));
    expect(bridgeNameFor("runway-net-a")).not.toBe(bridgeNameFor("runway-net-b"));
  });

  it("reads the mode from the environment, defaulting to per-app", () => {
    expect(networkMode({})).toBe("per-app");
    expect(networkMode({ RUNWAY_APP_NETWORK_MODE: "shared" })).toBe("shared");
    expect(networkMode({ RUNWAY_APP_NETWORK_MODE: "nonsense" })).toBe("per-app");
  });
});

describe("IPv4 helpers", () => {
  it("round-trips addresses", () => {
    expect(intToIp(ipToInt("10.250.1.17"))).toBe("10.250.1.17");
    expect(ipToInt("0.0.0.1")).toBe(1);
  });

  it("rejects things that are not IPv4", () => {
    expect(() => ipToInt("10.0.0")).toThrow();
    expect(() => ipToInt("10.0.0.256")).toThrow();
    expect(() => parseCidr("fd00::/8")).toThrow();
    expect(() => parseCidr("10.0.0.0/33")).toThrow();
  });

  it("normalises a CIDR to its network address", () => {
    expect(formatCidr(parseCidr("10.250.1.77/28"))).toBe("10.250.1.64/28");
  });

  it("detects overlap in both directions and for nested ranges", () => {
    const big = parseCidr("10.250.0.0/16");
    const small = parseCidr("10.250.7.16/28");
    expect(cidrOverlaps(big, small)).toBe(true);
    expect(cidrOverlaps(small, big)).toBe(true);
    expect(cidrOverlaps(small, parseCidr("10.250.7.32/28"))).toBe(false);
  });
});

describe("nextFreeSubnet", () => {
  it("starts at the beginning of the pool", () => {
    expect(nextFreeSubnet("10.250.0.0/16", 28, [])).toBe("10.250.0.0/28");
  });

  it("skips what is taken, also by a larger or partly overlapping network", () => {
    expect(nextFreeSubnet("10.250.0.0/16", 28, ["10.250.0.0/28", "10.250.0.16/28"])).toBe("10.250.0.32/28");
    expect(nextFreeSubnet("10.250.0.0/16", 28, ["10.250.0.0/24"])).toBe("10.250.1.0/28");
  });

  it("ignores IPv6 and malformed entries", () => {
    expect(nextFreeSubnet("10.250.0.0/16", 28, ["fd00::/64", "", "garbage"])).toBe("10.250.0.0/28");
  });

  it("throws, with a hint, when the pool is full", () => {
    expect(() => nextFreeSubnet("10.250.0.0/30", 30, ["10.250.0.0/30"])).toThrow(/RUNWAY_APP_NET_POOL/);
  });

  it("refuses a slice size that does not fit the pool", () => {
    expect(() => nextFreeSubnet("10.250.0.0/24", 16, [])).toThrow();
    expect(() => nextFreeSubnet("10.250.0.0/24", 31, [])).toThrow();
  });

  it("does not hand out the default Docker ranges", () => {
    const first = nextFreeSubnet(DEFAULT_POOL, 28, ["172.18.0.0/16", "172.19.0.0/16"]);
    expect(first.startsWith("10.250.")).toBe(true);
  });
});

describe("ensureAppNetwork", () => {
  it("creates a labelled network with its own bridge name and a subnet from the pool", async () => {
    const d = new FakeDocker();
    await ensureAppNetwork(d, "runway-net-a", "a");
    const n = d.nets.get("runway-net-a")!;
    expect(n.Labels["runway.role"]).toBe(APP_NETWORK_ROLE);
    expect(n.Labels["runway.app"]).toBe("a");
    expect(n.BridgeName).toBe(bridgeNameFor("runway-net-a"));
    expect(n.Subnet).toBe("10.250.0.0/28");
  });

  it("is idempotent: an existing network is left alone", async () => {
    const d = new FakeDocker();
    await ensureAppNetwork(d, "runway-net-a", "a");
    const before = d.nets.get("runway-net-a")!.Subnet;
    await ensureAppNetwork(d, "runway-net-a", "a");
    expect(d.calls.filter((c) => c.startsWith("create"))).toHaveLength(1);
    expect(d.nets.get("runway-net-a")!.Subnet).toBe(before);
  });

  it("gives concurrent deploys different subnets", async () => {
    const d = new FakeDocker();
    await Promise.all(["a", "b", "c", "d"].map((x) => ensureAppNetwork(d, `runway-net-${x}`, x)));
    const subnets = d.appNetworks().map((n) => n.Subnet);
    expect(new Set(subnets).size).toBe(4);
  });

  it("avoids a subnet an unrelated network already uses", async () => {
    const d = new FakeDocker();
    d.addNet("someone-elses", "10.250.0.0/24");
    await ensureAppNetwork(d, "runway-net-a", "a");
    expect(d.nets.get("runway-net-a")!.Subnet).toBe("10.250.1.0/28");
  });

  it("honours RUNWAY_APP_NET_POOL and RUNWAY_APP_NET_PREFIX", async () => {
    const d = new FakeDocker();
    await ensureAppNetwork(d, "runway-net-a", "a", {
      RUNWAY_APP_NET_POOL: "10.99.0.0/20",
      RUNWAY_APP_NET_PREFIX: "27",
    });
    expect(d.nets.get("runway-net-a")!.Subnet).toBe("10.99.0.0/27");
  });

  it("treats a create that lost a race (409) as success", async () => {
    const d = new FakeDocker();
    d.failCreate = Object.assign(new Error("exists"), { statusCode: 409 });
    await expect(ensureAppNetwork(d, "runway-net-a", "a")).resolves.toBeUndefined();
  });

  it("fails loudly on any other error, so a deploy never falls back to a shared network", async () => {
    const d = new FakeDocker();
    d.failCreate = Object.assign(new Error("boom"), { statusCode: 500 });
    await expect(ensureAppNetwork(d, "runway-net-a", "a")).rejects.toThrow("boom");
  });

  it("fails when the pool is full", async () => {
    const d = new FakeDocker();
    await expect(
      ensureAppNetwork(d, "runway-net-a", "a", { RUNWAY_APP_NET_POOL: "10.99.0.0/30", RUNWAY_APP_NET_PREFIX: "30" })
    ).resolves.toBeUndefined();
    await expect(
      ensureAppNetwork(d, "runway-net-b", "b", { RUNWAY_APP_NET_POOL: "10.99.0.0/30", RUNWAY_APP_NET_PREFIX: "30" })
    ).rejects.toThrow(/No free subnet/);
  });
});

describe("connectGateway", () => {
  it("attaches the gateway, and tolerates it already being attached", async () => {
    const d = new FakeDocker();
    await ensureAppNetwork(d, "runway-net-a", "a");
    await connectGateway(d, "runway-net-a");
    await connectGateway(d, "runway-net-a");
    expect(d.nets.get("runway-net-a")!.members.has("runway-gateway")).toBe(true);
  });

  it("surfaces other errors (no network, no gateway)", async () => {
    const d = new FakeDocker({ gateway: null });
    await ensureAppNetwork(d, "runway-net-a", "a");
    await expect(connectGateway(d, "runway-net-a")).rejects.toThrow(/not found/);
    await expect(connectGateway(d, "runway-net-missing")).rejects.toThrow(/not found/);
  });
});

describe("removeAppNetwork", () => {
  it("detaches the gateway and removes the network", async () => {
    const d = new FakeDocker();
    await ensureAppNetwork(d, "runway-net-a", "a");
    await connectGateway(d, "runway-net-a");
    expect(await removeAppNetwork(d, "runway-net-a")).toBe(true);
    expect(d.nets.has("runway-net-a")).toBe(false);
    expect(d.containers.get("runway-gateway")!.has("runway-net-a")).toBe(false);
  });

  it("keeps a network that still has an app container on it", async () => {
    const d = new FakeDocker();
    await ensureAppNetwork(d, "runway-net-a", "a");
    await connectGateway(d, "runway-net-a");
    d.join("runway-net-a", "runway-app-a");
    expect(await removeAppNetwork(d, "runway-net-a")).toBe(false);
    expect(d.nets.has("runway-net-a")).toBe(true);
  });

  it("is quiet about a network that is already gone", async () => {
    const d = new FakeDocker();
    expect(await removeAppNetwork(d, "runway-net-nope")).toBe(false);
  });
});

describe("planReconcile", () => {
  const nets = [
    { name: "n-a", appId: "a" },
    { name: "n-b", appId: "b" },
    { name: "n-gone", appId: "gone" },
  ];

  it("connects networks the gateway has lost and removes empty networks of deleted apps", () => {
    const plan = planReconcile({
      networks: nets,
      appIds: new Set(["a", "b"]),
      gatewayOn: new Set(["n-b"]),
      occupants: { "n-a": 1, "n-gone": 0 },
    });
    expect(plan.connect).toEqual(["n-a"]);
    expect(plan.orphans).toEqual(["n-gone"]);
  });

  it("never removes a network that still holds a container, nor a network without an app label", () => {
    const plan = planReconcile({
      networks: [{ name: "n-gone", appId: "gone" }, { name: "n-nolabel" }],
      appIds: new Set(),
      gatewayOn: new Set(),
      occupants: { "n-gone": 1, "n-nolabel": 0 },
    });
    expect(plan.orphans).toEqual([]);
    expect(plan.connect).toEqual(["n-gone", "n-nolabel"]);
  });
});

describe("reconcileGatewayNetworks", () => {
  async function withApps(d: FakeDocker, ids: string[]) {
    for (const id of ids) {
      await ensureAppNetwork(d, `runway-net-${id}`, id);
      await connectGateway(d, `runway-net-${id}`);
      d.join(`runway-net-${id}`, `runway-app-${id}`);
    }
  }

  it("does nothing when everything is attached", async () => {
    const d = new FakeDocker();
    await withApps(d, ["a", "b"]);
    const r = await reconcileGatewayNetworks(d, new Set(["a", "b"]));
    expect(r.connect).toEqual([]);
    expect(r.orphans).toEqual([]);
    expect(r.errors).toEqual([]);
  });

  it("reattaches the gateway after it was recreated (docker compose up)", async () => {
    const d = new FakeDocker();
    await withApps(d, ["a", "b"]);
    d.recreate("runway-gateway", ["runway-internal", "runway-apps"]);
    expect(d.nets.get("runway-net-a")!.members.has("runway-gateway")).toBe(false);

    const r = await reconcileGatewayNetworks(d, new Set(["a", "b"]));
    expect(r.connect.sort()).toEqual(["runway-net-a", "runway-net-b"]);
    expect(d.nets.get("runway-net-a")!.members.has("runway-gateway")).toBe(true);
    expect(d.nets.get("runway-net-b")!.members.has("runway-gateway")).toBe(true);
  });

  it("removes the network of a deleted app once nothing but the gateway is on it", async () => {
    const d = new FakeDocker();
    await withApps(d, ["a", "gone"]);
    d.nets.get("runway-net-gone")!.members.delete("runway-app-gone");
    const r = await reconcileGatewayNetworks(d, new Set(["a"]));
    expect(r.orphans).toEqual(["runway-net-gone"]);
    expect(d.nets.has("runway-net-gone")).toBe(false);
    expect(d.nets.has("runway-net-a")).toBe(true);
  });

  it("keeps the network of a deleted app while its container is still there", async () => {
    const d = new FakeDocker();
    await withApps(d, ["gone"]);
    const r = await reconcileGatewayNetworks(d, new Set());
    expect(r.orphans).toEqual([]);
    expect(d.nets.has("runway-net-gone")).toBe(true);
  });

  it("counts the app containers that have not moved off the shared network yet", async () => {
    const d = new FakeDocker();
    d.join("runway-apps", "runway-app-old1");
    d.join("runway-apps", "runway-app-old2");
    const r = await reconcileGatewayNetworks(d, new Set(["old1", "old2"]));
    expect(r.legacy).toBe(2); // the gateway itself does not count
  });

  it("does not throw when the gateway container does not exist (development)", async () => {
    const d = new FakeDocker({ gateway: null });
    const r = await reconcileGatewayNetworks(d, new Set(["a"]));
    expect(r.errors[0]).toMatch(/runway-gateway/);
    expect(r.connect).toEqual([]);
  });

  it("reports a failed attach and carries on with the rest", async () => {
    const d = new FakeDocker();
    await withApps(d, ["a", "b"]);
    d.recreate("runway-gateway", ["runway-internal"]);
    const real = d.getNetwork.bind(d);
    d.getNetwork = ((name: string) => {
      const n = real(name);
      if (name === "runway-net-a") return { ...n, connect: async () => { throw new Error("denied"); } };
      return n;
    }) as typeof d.getNetwork;
    const r = await reconcileGatewayNetworks(d, new Set(["a", "b"]));
    expect(r.errors.some((e) => e.includes("runway-net-a"))).toBe(true);
    expect(d.nets.get("runway-net-b")!.members.has("runway-gateway")).toBe(true);
  });
});

describe("moving an app from the shared network to its own", () => {
  it("leaves the old container on the shared network until it is replaced, then the app is isolated", async () => {
    const d = new FakeDocker();
    d.join("runway-apps", "runway-app-x"); // created by an older release
    d.join("runway-apps", "runway-app-y");

    // Redeploy of x: network + gateway first, then the container is recreated on it.
    await ensureAppNetwork(d, "runway-net-x", "x");
    await connectGateway(d, "runway-net-x");
    d.containers.get("runway-app-x")!.delete("runway-apps");
    d.nets.get("runway-apps")!.members.delete("runway-app-x");
    d.join("runway-net-x", "runway-app-x");

    // x is on its own network only; y still works on the shared one.
    expect([...d.containers.get("runway-app-x")!]).toEqual(["runway-net-x"]);
    expect([...d.containers.get("runway-app-y")!]).toEqual(["runway-apps"]);
    // The gateway sees both, so routes of old and new apps keep resolving.
    expect(d.containers.get("runway-gateway")!.has("runway-apps")).toBe(true);
    expect(d.containers.get("runway-gateway")!.has("runway-net-x")).toBe(true);
    // The two apps share no network.
    const shared = [...d.containers.get("runway-app-x")!].filter((n) => d.containers.get("runway-app-y")!.has(n));
    expect(shared).toEqual([]);

    const r = await reconcileGatewayNetworks(d, new Set(["x", "y"]));
    expect(r.legacy).toBe(1);
  });
});

describe("startGatewayNetworkReconciler", () => {
  it("runs at once, logs a legacy count once, and stops when asked", async () => {
    const d = new FakeDocker();
    d.join("runway-apps", "runway-app-old");
    const logs: string[] = [];
    const stop = startGatewayNetworkReconciler({
      docker: d,
      appIds: () => new Set(["old"]),
      log: (m) => logs.push(m),
      intervalMs: 5,
    });
    await vi.waitFor(() => expect(logs.some((l) => l.includes("still on the shared"))).toBe(true));
    await new Promise((r) => setTimeout(r, 30));
    expect(logs.filter((l) => l.includes("still on the shared"))).toHaveLength(1);
    stop();
  });

  it("reattaches the gateway on a later tick", async () => {
    const d = new FakeDocker();
    await ensureAppNetwork(d, "runway-net-a", "a");
    await connectGateway(d, "runway-net-a");
    d.join("runway-net-a", "runway-app-a");
    const logs: string[] = [];
    const stop = startGatewayNetworkReconciler({
      docker: d,
      appIds: () => new Set(["a"]),
      log: (m) => logs.push(m),
      intervalMs: 5,
    });
    d.recreate("runway-gateway", ["runway-internal"]);
    await vi.waitFor(() => expect(d.nets.get("runway-net-a")!.members.has("runway-gateway")).toBe(true));
    stop();
  });

  it("does nothing in shared mode", async () => {
    const prev = process.env.RUNWAY_APP_NETWORK_MODE;
    process.env.RUNWAY_APP_NETWORK_MODE = "shared";
    try {
      const d = new FakeDocker();
      await ensureAppNetwork(d, "runway-net-a", "a");
      const stop = startGatewayNetworkReconciler({ docker: d, appIds: () => new Set(["a"]), intervalMs: 5 });
      await new Promise((r) => setTimeout(r, 30));
      expect(d.nets.get("runway-net-a")!.members.has("runway-gateway")).toBe(false);
      stop();
    } finally {
      if (prev === undefined) delete process.env.RUNWAY_APP_NETWORK_MODE;
      else process.env.RUNWAY_APP_NETWORK_MODE = prev;
    }
  });
});
