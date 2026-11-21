import { describe, it, expect } from "vitest";
import { judgeHealth, waitForHealthy } from "./health.js";
import type { ContainerStatus } from "./docker.js";

const st = (o: Partial<ContainerStatus>): ContainerStatus => ({ exists: true, ...o });

describe("judgeHealth", () => {
  it("missing container is unhealthy", () => {
    expect(judgeHealth({ exists: false }, true, 0, 10)).toBe("unhealthy");
  });
  it("exited / restarting / dead are unhealthy", () => {
    for (const state of ["exited", "restarting", "dead"]) {
      expect(judgeHealth(st({ state }), false, 99999, 10)).toBe("unhealthy");
    }
  });
  it("with healthcheck: follows docker health", () => {
    expect(judgeHealth(st({ state: "running", health: "starting" }), true, 5, 10)).toBe("pending");
    expect(judgeHealth(st({ state: "running", health: "healthy" }), true, 5, 10)).toBe("healthy");
    expect(judgeHealth(st({ state: "running", health: "unhealthy" }), true, 5, 10)).toBe("unhealthy");
  });
  it("without healthcheck: running must be stable first", () => {
    expect(judgeHealth(st({ state: "running" }), false, 3, 10)).toBe("pending");
    expect(judgeHealth(st({ state: "running" }), false, 10, 10)).toBe("healthy");
  });
});

describe("waitForHealthy", () => {
  function fakeClock() {
    let t = 0;
    return { now: () => t, sleep: async (ms: number) => { t += ms; } };
  }
  it("returns healthy once docker reports healthy", async () => {
    const clock = fakeClock();
    const seq = [st({ state: "running", health: "starting" }), st({ state: "running", health: "healthy" })];
    let i = 0;
    const r = await waitForHealthy("x", { hasHealthcheck: true, getStatus: async () => seq[Math.min(i++, 1)], ...clock });
    expect(r.healthy).toBe(true);
  });
  it("fails fast when the container exits", async () => {
    const clock = fakeClock();
    const r = await waitForHealthy("x", { hasHealthcheck: false, getStatus: async () => st({ state: "exited" }), ...clock });
    expect(r.healthy).toBe(false);
    expect(r.reason).toContain("exited");
  });
  it("times out as unhealthy", async () => {
    const clock = fakeClock();
    const r = await waitForHealthy("x", { hasHealthcheck: true, timeoutMs: 6000, getStatus: async () => st({ state: "running", health: "starting" }), ...clock });
    expect(r.healthy).toBe(false);
    expect(r.reason).toContain("not healthy after");
  });
});
