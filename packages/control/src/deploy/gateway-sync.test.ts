import { describe, expect, it, vi } from "vitest";
import { needsSsoRouteRepair, repairSsoRoutes } from "./gateway-sync.js";
import type { App } from "../db/apps.js";

const mk = (o: Partial<App>): App =>
  ({ id: "a", domain: "a.apps.test", custom_domain: "www.a.test", sso_enabled: 1, status: "running", ...o }) as App;

describe("needsSsoRouteRepair", () => {
  it("is true only for SSO apps with a custom domain that are not quarantined", () => {
    expect(needsSsoRouteRepair(mk({}))).toBe(true);
    expect(needsSsoRouteRepair(mk({ sso_enabled: 0 }))).toBe(false);
    expect(needsSsoRouteRepair(mk({ custom_domain: null }))).toBe(false);
    expect(needsSsoRouteRepair(mk({ domain: null }))).toBe(false);
    expect(needsSsoRouteRepair(mk({ status: "quarantined" }))).toBe(false);
  });
});

describe("repairSsoRoutes", () => {
  it("rewrites only apps that need it and already have a route file", async () => {
    const writeRoute = vi.fn(async () => {});
    const fixed = await repairSsoRoutes({
      listApps: () => [
        mk({ id: "ok" }),
        mk({ id: "no-file" }),
        mk({ id: "plain", sso_enabled: 0 }),
        mk({ id: "q", status: "quarantined" }),
      ],
      routeExists: async (id) => id !== "no-file",
      writeRoute,
    });
    expect(fixed).toEqual(["ok"]);
    expect(writeRoute).toHaveBeenCalledTimes(1);
  });

  it("keeps going when one app fails and never throws", async () => {
    const log = vi.fn();
    const fixed = await repairSsoRoutes({
      listApps: () => [mk({ id: "bad" }), mk({ id: "good" })],
      routeExists: async () => true,
      writeRoute: async (a) => {
        if (a.id === "bad") throw new Error("disk full");
      },
      log,
    });
    expect(fixed).toEqual(["good"]);
    expect(log).toHaveBeenCalledWith(expect.stringContaining("bad"));
  });

  it("does nothing when no app qualifies", async () => {
    expect(
      await repairSsoRoutes({ listApps: () => [], routeExists: async () => true, writeRoute: async () => {} })
    ).toEqual([]);
  });
});
