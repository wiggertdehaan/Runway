import { describe, it, expect, afterEach, vi } from "vitest";
import { buildctlArgs, docker, runContainer } from "./docker.js";
import { FakeDocker } from "./fake-docker.js";

describe("buildctlArgs", () => {
  const base = { imageTag: "runway-app-x:v1", contextDir: "/exchange/b-ctx", outputPath: "/exchange/b-out.tar" };
  it("omits --no-cache by default", () => {
    expect(buildctlArgs(base)).not.toContain("--no-cache");
  });
  it("adds --no-cache for rebuilds, before the --local flags", () => {
    const args = buildctlArgs({ ...base, noCache: true });
    expect(args).toContain("--no-cache");
    expect(args.indexOf("--no-cache")).toBeLessThan(args.indexOf("--local"));
  });
  it("passes build-args sorted, as --opt build-arg:K=V", () => {
    const args = buildctlArgs({ ...base, buildArgs: { Z: "1", A: "nginx:1.30.7-alpine" } });
    const i = args.indexOf("build-arg:A=nginx:1.30.7-alpine");
    expect(i).toBeGreaterThan(0);
    expect(args[i - 1]).toBe("--opt");
    expect(args.indexOf("build-arg:Z=1")).toBeGreaterThan(i);
  });
  it("passes a custom Dockerfile name", () => {
    const args = buildctlArgs({ ...base, dockerfile: "Dockerfile.prod" });
    expect(args).toContain("filename=Dockerfile.prod");
  });
});

/** Point the shared dockerode client at an in-memory daemon: containers are absent, networks are real enough. */
function fakeDaemon(fake = new FakeDocker()) {
  vi.spyOn(docker, "getContainer").mockReturnValue({
    inspect: async () => {
      throw Object.assign(new Error("no such container"), { statusCode: 404 });
    },
  } as never);
  vi.spyOn(docker, "listNetworks").mockImplementation(((o?: never) => fake.listNetworks(o)) as never);
  vi.spyOn(docker, "createNetwork").mockImplementation(((o: Record<string, unknown>) => fake.createNetwork(o)) as never);
  vi.spyOn(docker, "getNetwork").mockImplementation(((n: string) => fake.getNetwork(n)) as never);
  const created: Array<Record<string, any>> = [];
  vi.spyOn(docker, "createContainer").mockImplementation((async (o: Record<string, any>) => {
    created.push(o);
    fake.calls.push(`createContainer ${o.name}`);
    fake.join(o.HostConfig.NetworkMode, o.name);
    return { id: "c1", start: async () => {} };
  }) as never);
  return { fake, created };
}

describe("runContainer healthcheck", () => {
  afterEach(() => vi.restoreAllMocks());

  /** Run runContainer against a mocked Docker client and return the create options. */
  async function createOptions(port: number, healthCheckPath: string | null) {
    const { created } = fakeDaemon();
    await runContainer({ containerName: "runway-app-x", imageTag: "img:v1", port, healthCheckPath });
    return created[0] as { Healthcheck?: { Test: string[] } };
  }

  it("probes the IPv4 loopback address, never the name 'localhost'", async () => {
    // Inside the container "localhost" can resolve to ::1 while apps bind
    // 0.0.0.0 only, which left every such app unhealthy forever and made
    // health-verified rebuilds roll back.
    const opts = await createOptions(3000, "/healthz");
    expect(opts.Healthcheck?.Test).toEqual(["CMD", "wget", "-qO-", "http://127.0.0.1:3000/healthz"]);
    expect(JSON.stringify(opts.Healthcheck)).not.toContain("localhost");
  });

  it("uses the app's own port (static apps listen on 80)", async () => {
    const opts = await createOptions(80, "/");
    expect(opts.Healthcheck?.Test?.[3]).toBe("http://127.0.0.1:80/");
  });

  it("adds no healthcheck when the app has no health path", async () => {
    const opts = await createOptions(3000, null);
    expect(opts.Healthcheck).toBeUndefined();
  });
});

describe("runContainer networks (S04)", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    delete process.env.RUNWAY_APP_NETWORK_MODE;
  });

  it("puts the app on its own network, not on the shared one", async () => {
    const { created } = fakeDaemon();
    await runContainer({ containerName: "runway-app-abc", imageTag: "img:v1", port: 3000, appId: "abc" });
    expect(created[0].HostConfig.NetworkMode).toBe("runway-net-abc");
    expect(created[0].HostConfig.NetworkMode).not.toBe("runway-apps");
  });

  it("attaches the gateway to that network BEFORE the container exists, so routing works from the first request", async () => {
    const { fake } = fakeDaemon();
    await runContainer({ containerName: "runway-app-abc", imageTag: "img:v1", port: 3000, appId: "abc" });
    const iNet = fake.calls.indexOf("create runway-net-abc");
    const iGw = fake.calls.indexOf("connect runway-net-abc runway-gateway");
    const iRun = fake.calls.indexOf("createContainer runway-app-abc");
    expect(iNet).toBeGreaterThanOrEqual(0);
    expect(iGw).toBeGreaterThan(iNet);
    expect(iRun).toBeGreaterThan(iGw);
  });

  it("labels the network with the app so the reconcile sweep can tell whose it is", async () => {
    const { fake } = fakeDaemon();
    await runContainer({ containerName: "runway-app-abc", imageTag: "img:v1", port: 3000, appId: "abc" });
    expect(fake.nets.get("runway-net-abc")!.Labels["runway.app"]).toBe("abc");
  });

  it("reuses the network on a redeploy or rebuild", async () => {
    const { fake } = fakeDaemon();
    await runContainer({ containerName: "runway-app-abc", imageTag: "img:v1", port: 3000, appId: "abc" });
    await runContainer({ containerName: "runway-app-abc", imageTag: "img:v2", port: 3000, appId: "abc" });
    expect(fake.calls.filter((c) => c === "create runway-net-abc")).toHaveLength(1);
  });

  it("gives two apps two networks that share nothing but the gateway", async () => {
    const { fake } = fakeDaemon();
    await runContainer({ containerName: "runway-app-a", imageTag: "i:1", port: 3000, appId: "a" });
    await runContainer({ containerName: "runway-app-b", imageTag: "i:1", port: 3000, appId: "b" });
    const a = fake.containers.get("runway-app-a")!;
    const b = fake.containers.get("runway-app-b")!;
    expect([...a].filter((n) => b.has(n))).toEqual([]);
    expect(fake.containers.get("runway-gateway")!.has("runway-net-a")).toBe(true);
    expect(fake.containers.get("runway-gateway")!.has("runway-net-b")).toBe(true);
  });

  it("fails the deploy, creating no container, when the network cannot be made", async () => {
    const fake = new FakeDocker();
    fake.failCreate = Object.assign(new Error("address pool exhausted"), { statusCode: 500 });
    const { created } = fakeDaemon(fake);
    await expect(
      runContainer({ containerName: "runway-app-abc", imageTag: "img:v1", port: 3000, appId: "abc" })
    ).rejects.toThrow("address pool exhausted");
    expect(created).toHaveLength(0);
  });

  it("fails the deploy when the gateway cannot be attached (the app would be unreachable)", async () => {
    const { created } = fakeDaemon(new FakeDocker({ gateway: null }));
    await expect(
      runContainer({ containerName: "runway-app-abc", imageTag: "img:v1", port: 3000, appId: "abc" })
    ).rejects.toThrow();
    expect(created).toHaveLength(0);
  });

  it("RUNWAY_APP_NETWORK_MODE=shared is the way back to the old behaviour", async () => {
    process.env.RUNWAY_APP_NETWORK_MODE = "shared";
    const { created, fake } = fakeDaemon();
    await runContainer({ containerName: "runway-app-abc", imageTag: "img:v1", port: 3000, appId: "abc" });
    expect(created[0].HostConfig.NetworkMode).toBe("runway-apps");
    expect(fake.calls.some((c) => c.startsWith("create runway-net"))).toBe(false);
  });
});

describe("runContainer hardening (S08)", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    delete process.env.RUNWAY_HARDENING;
    delete process.env.RUNWAY_PIDS_LIMIT;
  });

  async function hostConfig(extra: Partial<Parameters<typeof runContainer>[0]> = {}) {
    const { created } = fakeDaemon();
    await runContainer({
      containerName: "runway-app-h",
      imageTag: "img:v1",
      port: 3000,
      appId: "h",
      memoryLimit: "512m",
      cpuLimit: "1",
      ...extra,
    });
    return created[0].HostConfig as Record<string, any>;
  }

  it("drops all capabilities, adds back only the small list, and blocks privilege gain", async () => {
    const hc = await hostConfig();
    expect(hc.CapDrop).toEqual(["ALL"]);
    expect(hc.CapAdd).toEqual(["CHOWN", "DAC_OVERRIDE", "FOWNER", "SETGID", "SETUID", "NET_BIND_SERVICE"]);
    expect(hc.SecurityOpt).toEqual(["no-new-privileges:true"]);
  });

  it("limits PIDs, disables swap and rotates logs", async () => {
    const hc = await hostConfig();
    expect(hc.PidsLimit).toBe(512);
    expect(hc.Memory).toBe(512 * 1024 * 1024);
    expect(hc.MemorySwap).toBe(hc.Memory);
    expect(hc.LogConfig).toEqual({ Type: "json-file", Config: { "max-size": "10m", "max-file": "3" } });
  });

  it("keeps the memory and CPU limits exactly as before", async () => {
    const hc = await hostConfig({ memoryLimit: "1g", cpuLimit: "2" });
    expect(hc.Memory).toBe(1024 * 1024 * 1024);
    expect(hc.NanoCpus).toBe(2e9);
  });

  it("an app without a memory limit gets no swap rule", async () => {
    const hc = await hostConfig({ memoryLimit: undefined });
    expect(hc.Memory).toBeUndefined();
    expect(hc.MemorySwap).toBeUndefined();
  });

  it("never sets Privileged, a host namespace, a device or Mounts", async () => {
    const hc = await hostConfig({ volumes: ["runway-data-h-data:/data"] });
    expect(hc.Privileged).toBeUndefined();
    for (const k of ["PidMode", "IpcMode", "UTSMode", "UsernsMode", "CgroupnsMode", "Devices", "Mounts"]) {
      expect(hc[k]).toBeUndefined();
    }
    expect(hc.NetworkMode).toBe("runway-net-h");
  });

  it("passes only named volumes as Binds", async () => {
    const hc = await hostConfig({ volumes: ["runway-data-h-data:/data", "runway-data-h-uploads:/uploads"] });
    expect(hc.Binds).toEqual(["runway-data-h-data:/data", "runway-data-h-uploads:/uploads"]);
    for (const b of hc.Binds as string[]) expect(b.split(":")[0]).not.toContain("/");
  });

  it("refuses to create the container when a bind would be a host path (the Docker socket)", async () => {
    const { created } = fakeDaemon();
    await expect(
      runContainer({
        containerName: "runway-app-h",
        imageTag: "img:v1",
        port: 3000,
        appId: "h",
        volumes: ["/var/run/docker.sock:/var/run/docker.sock"],
      })
    ).rejects.toThrow(/host path/);
    expect(created).toHaveLength(0);
  });

  it("the strict profile adds no capabilities back", async () => {
    const hc = await hostConfig({ hardening: "strict" });
    expect(hc.CapDrop).toEqual(["ALL"]);
    expect(hc.CapAdd).toBeUndefined();
  });

  it("the relaxed profile keeps Docker's defaults but still rotates logs", async () => {
    const hc = await hostConfig({ hardening: "relaxed", readonlyRootfs: true });
    expect(hc.CapDrop).toBeUndefined();
    expect(hc.CapAdd).toBeUndefined();
    expect(hc.SecurityOpt).toBeUndefined();
    expect(hc.PidsLimit).toBeUndefined();
    expect(hc.MemorySwap).toBeUndefined();
    expect(hc.ReadonlyRootfs).toBeUndefined();
    expect(hc.LogConfig.Config["max-size"]).toBe("10m");
    expect(hc.Memory).toBe(512 * 1024 * 1024);
  });

  it("RUNWAY_HARDENING=relaxed is an emergency brake over a per-app strict", async () => {
    process.env.RUNWAY_HARDENING = "relaxed";
    const hc = await hostConfig({ hardening: "strict" });
    expect(hc.CapDrop).toBeUndefined();
    expect(hc.PidsLimit).toBeUndefined();
  });

  it("RUNWAY_HARDENING=strict is the instance default; an unknown value does not weaken anything", async () => {
    process.env.RUNWAY_HARDENING = "strict";
    expect((await hostConfig()).CapAdd).toBeUndefined();
    process.env.RUNWAY_HARDENING = "off";
    const hc = await hostConfig();
    expect(hc.CapDrop).toEqual(["ALL"]);
    expect(hc.CapAdd).toHaveLength(6);
  });

  it("RUNWAY_PIDS_LIMIT raises the limit within bounds", async () => {
    process.env.RUNWAY_PIDS_LIMIT = "2048";
    expect((await hostConfig()).PidsLimit).toBe(2048);
    process.env.RUNWAY_PIDS_LIMIT = "5";
    expect((await hostConfig()).PidsLimit).toBe(64);
  });

  it("the read-only root filesystem is off by default and opt-in per app, with a writable /tmp", async () => {
    const off = await hostConfig();
    expect(off.ReadonlyRootfs).toBeUndefined();
    expect(off.Tmpfs).toBeUndefined();
    const on = await hostConfig({ readonlyRootfs: true });
    expect(on.ReadonlyRootfs).toBe(true);
    expect(Object.keys(on.Tmpfs)).toEqual(["/tmp"]);
  });

  it("hardening applies in the shared-network emergency mode too", async () => {
    process.env.RUNWAY_APP_NETWORK_MODE = "shared";
    try {
      const hc = await hostConfig();
      expect(hc.NetworkMode).toBe("runway-apps");
      expect(hc.CapDrop).toEqual(["ALL"]);
    } finally {
      delete process.env.RUNWAY_APP_NETWORK_MODE;
    }
  });
});
