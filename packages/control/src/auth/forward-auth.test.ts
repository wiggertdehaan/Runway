import { describe, expect, it } from "vitest";
import { decideForwardAuth, normalizeHost, safeAppPath, takeTicket, withTicket, TICKET_PARAM } from "./forward-auth.js";

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

  it("treats the custom domain like the app's own host (host-only app cookie makes that safe)", () => {
    const d = decideForwardAuth({ ...base, host: "www.example.test" });
    expect(d).toEqual({ action: "allow", user: "sam@corp.example" });
    expect(decideForwardAuth({ ...base, host: "www.example.test", hasSession: false, user: undefined })).toEqual({
      action: "login",
    });
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

describe("safeAppPath", () => {
  it("keeps plain absolute paths with a query", () => {
    expect(safeAppPath("/")).toBe("/");
    expect(safeAppPath("/a/b?x=1&y=2")).toBe("/a/b?x=1&y=2");
  });
  it("turns anything that could leave the host into /", () => {
    for (const bad of [
      "https://evil.example/",
      "//evil.example/",
      "/\\evil.example",
      "javascript:alert(1)",
      "evil",
      "/a\r\nSet-Cookie: x=1",
      "/" + "a".repeat(3000),
      "",
      undefined,
      null,
    ]) {
      expect(safeAppPath(bad as string | undefined | null)).toBe("/");
    }
  });
});

describe("ticket in the URL", () => {
  it("adds and removes the ticket without touching the rest of the query", () => {
    const withIt = withTicket("/dash?tab=2", "T1");
    expect(withIt).toBe(`/dash?tab=2&${TICKET_PARAM}=T1`);
    expect(takeTicket(withIt)).toEqual({ uri: "/dash?tab=2", ticket: "T1" });
    expect(takeTicket(withTicket("/dash", "T2"))).toEqual({ uri: "/dash", ticket: "T2" });
  });
  it("finds no ticket where there is none", () => {
    expect(takeTicket("/dash?tab=2")).toEqual({ uri: "/dash?tab=2", ticket: null });
    expect(takeTicket("/")).toEqual({ uri: "/", ticket: null });
  });
});
