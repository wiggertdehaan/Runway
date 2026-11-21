import { describe, it, expect } from "vitest";
import { buildctlArgs } from "./docker.js";

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
