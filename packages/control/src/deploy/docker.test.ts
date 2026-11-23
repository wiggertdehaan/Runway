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
