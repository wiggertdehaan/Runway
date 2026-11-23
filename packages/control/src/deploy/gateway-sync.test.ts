import { describe, expect, it, vi } from "vitest";
import { needsRouteRefresh, needsSsoRouteRepair, refreshAppRoutes, repairSsoRoutes } from "./gateway-sync.js";
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

describe("refreshAppRoutes (S23: header strip reaches running apps without a redeploy)", () => {
  it("rewrites every app that has a route file and is not quarantined, SSO or not", async () => {
    const writeRoute = vi.fn(async () => {});
    const log = vi.fn();
    const done = await refreshAppRoutes({
      listApps: () => [
        mk({ id: "plain", sso_enabled: 0, custom_domain: null }),
        mk({ id: "basic", sso_enabled: 0 }),
        mk({ id: "no-file", sso_enabled: 0 }),
        mk({ id: "no-domain", domain: null }),
        mk({ id: "q", status: "quarantined" }),
        mk({ id: "already" }),
      ],
      routeExists: async (id) => id !== "no-file",
      writeRoute,
      skip: ["already"],
      log,
    });
    expect(done).toEqual(["plain", "basic"]);
    expect(writeRoute).toHaveBeenCalledTimes(2);
    expect(log).toHaveBeenCalledWith(expect.stringContaining("Refreshed the gateway route of 2 app(s)"));
  });

  it("needsRouteRefresh: a domain and not quarantined", () => {
    expect(needsRouteRefresh(mk({ sso_enabled: 0, custom_domain: null }))).toBe(true);
    expect(needsRouteRefresh(mk({ domain: null }))).toBe(false);
    expect(needsRouteRefresh(mk({ status: "quarantined" }))).toBe(false);
  });

  it("keeps going when one app fails and never throws", async () => {
    const log = vi.fn();
    const done = await refreshAppRoutes({
      listApps: () => [mk({ id: "bad" }), mk({ id: "good" })],
      routeExists: async () => true,
      writeRoute: async (a) => {
        if (a.id === "bad") throw new Error("disk full");
      },
      log,
    });
    expect(done).toEqual(["good"]);
    expect(log).toHaveBeenCalledWith(expect.stringContaining("Could not refresh the route of bad"));
  });

  it("logs nothing when there is nothing to do", async () => {
    const log = vi.fn();
    expect(await refreshAppRoutes({ listApps: () => [], routeExists: async () => true, writeRoute: async () => {}, log })).toEqual([]);
    expect(log).not.toHaveBeenCalled();
  });
});
