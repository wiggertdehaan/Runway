import { describe, it, expect, afterEach, vi } from "vitest";
import { buildctlArgs, docker, runContainer } from "./docker.js";

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

describe("runContainer healthcheck", () => {
  afterEach(() => vi.restoreAllMocks());

  /** Run runContainer against a mocked Docker client and return the create options. */
  async function createOptions(port: number, healthCheckPath: string | null) {
    vi.spyOn(docker, "getContainer").mockReturnValue({
      inspect: async () => {
        throw Object.assign(new Error("no such container"), { statusCode: 404 });
      },
    } as never);
    const create = vi
      .spyOn(docker, "createContainer")
      .mockResolvedValue({ id: "c1", start: async () => {} } as never);
    await runContainer({ containerName: "runway-app-x", imageTag: "img:v1", port, healthCheckPath });
    return create.mock.calls[0][0] as { Healthcheck?: { Test: string[] } };
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
