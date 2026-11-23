/** Scopes of a user token (S18): what a request needs, what a token covers. */
import { describe, expect, it } from "vitest";
import {
  ADMIN_ROUTES,
  grantableScopes,
  isScope,
  requiredScope,
  scopeCovers,
} from "./token-scopes.js";

describe("scopeCovers", () => {
  it("is a ladder: read < deploy < admin", () => {
    expect(scopeCovers("read", "read")).toBe(true);
    expect(scopeCovers("read", "deploy")).toBe(false);
    expect(scopeCovers("read", "admin")).toBe(false);
    expect(scopeCovers("deploy", "read")).toBe(true);
    expect(scopeCovers("deploy", "deploy")).toBe(true);
    expect(scopeCovers("deploy", "admin")).toBe(false);
    expect(scopeCovers("admin", "admin")).toBe(true);
    expect(scopeCovers("admin", "read")).toBe(true);
  });
  it("covers nothing for an unknown scope string", () => {
    expect(scopeCovers("root", "read")).toBe(false);
    expect(scopeCovers("", "read")).toBe(false);
  });
});

describe("requiredScope", () => {
  it("reads need read", () => {
    expect(requiredScope("GET", "/api/v1/app/status")).toBe("read");
    expect(requiredScope("get", "/api/v1/apps")).toBe("read");
    expect(requiredScope("HEAD", "/api/v1/app")).toBe("read");
  });
  it("anything that is not a plain read needs deploy, so a new route is never a free read", () => {
    for (const m of ["POST", "PUT", "PATCH", "DELETE", "PROPFIND"]) {
      expect(requiredScope(m, "/api/v1/app/anything-new")).toBe("deploy");
    }
  });
  it("names the admin routes explicitly", () => {
    for (const r of ADMIN_ROUTES) {
      const [method, path] = r.split(" ") as [string, string];
      expect(requiredScope(method, path)).toBe("admin");
    }
  });
});

describe("grantableScopes", () => {
  it("offers admin only to an administrator", () => {
    expect(grantableScopes("member")).toEqual(["read", "deploy"]);
    expect(grantableScopes("admin")).toEqual(["read", "deploy", "admin"]);
    expect(grantableScopes("")).toEqual(["read", "deploy"]);
  });
  it("isScope rejects anything else", () => {
    expect(isScope("read")).toBe(true);
    expect(isScope("write")).toBe(false);
    expect(isScope(undefined)).toBe(false);
  });
});
