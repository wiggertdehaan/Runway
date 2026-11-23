/**
 * The shared health checks: the summary the overview shows and the short
 * cache in front of it. The real checks (Docker, DNS, Trivy) are not run.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { cachedHealth, resetHealthCache, summarizeHealth, type HealthCheck } from "./health.js";

const ok = (name: string): HealthCheck => ({ name, ok: true, detail: "fine" });
const bad = (name: string): HealthCheck => ({ name, ok: false, detail: "broken" });

beforeEach(() => resetHealthCache());

describe("summarizeHealth", () => {
  it("counts every check and names the failed ones", () => {
    expect(summarizeHealth([ok("Docker"), bad("Traefik"), ok("BuildKit"), bad("Wildcard DNS")])).toEqual({
      total: 4,
      failed: ["Traefik", "Wildcard DNS"],
    });
    expect(summarizeHealth([])).toEqual({ total: 0, failed: [] });
  });

  it("never carries the detail text of a check", () => {
    expect(JSON.stringify(summarizeHealth([bad("Docker")]))).not.toContain("broken");
  });
});

describe("cachedHealth", () => {
  it("runs the checks once for callers within 30 seconds, and again after", async () => {
    let runs = 0;
    const run = async () => {
      runs++;
      return [ok("Docker")];
    };
    const t0 = 1_000_000;
    await cachedHealth(t0, run);
    await cachedHealth(t0 + 29_000, run);
    expect(runs).toBe(1);
    await cachedHealth(t0 + 31_000, run);
    expect(runs).toBe(2);
  });

  it("lets concurrent callers share one run", async () => {
    let runs = 0;
    const run = () =>
      new Promise<HealthCheck[]>((resolve) => {
        runs++;
        setTimeout(() => resolve([bad("Docker")]), 10);
      });
    const [a, b] = await Promise.all([cachedHealth(5, run), cachedHealth(5, run)]);
    expect(runs).toBe(1);
    expect(a).toEqual(b);
    expect(a.failed).toEqual(["Docker"]);
  });
});
