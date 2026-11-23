import { describe, expect, it } from "vitest";
import { decideForwardAuth, normalizeHost } from "./forward-auth.js";

const app = { id: "a1", domain: "shop.apps.example.com", sso_enabled: 1 };
const allowAll = () => true;
const base = {
  host: "shop.apps.example.com",
  app,
  hasSession: true,
  user: { email: "sam@corp.example" } as { email: string | null } | undefined,
  emailAllowed: allowAll,
};

describe("normalizeHost", () => {
  it("lowercases and drops port and trailing dot", () => {
    expect(normalizeHost("Shop.Apps.Example.com.:443")).toBe("shop.apps.example.com");
    expect(normalizeHost(undefined)).toBe("");
  });
});

describe("decideForwardAuth", () => {
  it("allows a signed-in, allowed user on the app's own host", () => {
    expect(decideForwardAuth(base)).toEqual({ action: "allow", user: "sam@corp.example" });
  });

  it("denies when there is no host", () => {
    for (const host of [undefined, null, "", "  "]) {
      expect(decideForwardAuth({ ...base, host }).action).toBe("deny");
    }
  });

  it("denies an unknown host", () => {
    expect(decideForwardAuth({ ...base, app: undefined })).toMatchObject({ action: "deny", status: 403 });
  });

  it("denies an app that has SSO switched off (stale gateway config)", () => {
    expect(decideForwardAuth({ ...base, app: { ...app, sso_enabled: 0 } })).toMatchObject({
      action: "deny",
    });
  });

  it("denies the custom domain instead of looping through login", () => {
    const d = decideForwardAuth({ ...base, host: "www.example.test" });
    expect(d).toMatchObject({ action: "deny", status: 403 });
    expect((d as { message: string }).message).toMatch(/custom domain/i);
  });

  it("asks anonymous visitors to log in, but only on the app's own host", () => {
    expect(decideForwardAuth({ ...base, hasSession: false, user: undefined })).toEqual({ action: "login" });
    expect(decideForwardAuth({ ...base, hasSession: true, user: undefined })).toEqual({ action: "login" });
  });

  it("denies a user without email or not on the app's allowlist", () => {
    expect(decideForwardAuth({ ...base, user: { email: null } }).action).toBe("deny");
    expect(decideForwardAuth({ ...base, emailAllowed: () => false }).action).toBe("deny");
  });

  it("compares hosts case-insensitively", () => {
    expect(decideForwardAuth({ ...base, host: "SHOP.apps.example.com" }).action).toBe("allow");
  });
});
