import { describe, expect, it } from "vitest";
import { Hono } from "hono";
import { clearSessionCookie, readSessionToken, setSessionCookie, sessionCookieName, ssoCookieName } from "./cookies.js";

const t = new Hono();
t.get("/set", (c) => {
  setSessionCookie(c, "tok");
  return c.text("ok");
});
t.get("/read", (c) => c.text(readSessionToken(c) ?? "none"));
t.get("/clear", (c) => {
  clearSessionCookie(c);
  return c.text("ok");
});

describe("cookie names", () => {
  it("prefix with __Host- only over HTTPS", () => {
    expect(sessionCookieName(true)).toBe("__Host-runway_session");
    expect(sessionCookieName(false)).toBe("runway_session");
    expect(ssoCookieName(true)).toBe("__Host-runway_sso");
    expect(ssoCookieName(false)).toBe("runway_sso");
  });
});

describe("session cookie", () => {
  it("is host-only (never a Domain attribute) in both modes", async () => {
    for (const proto of ["https", "http"]) {
      const r = await t.request("/set", { headers: { "x-forwarded-proto": proto } });
      expect(r.headers.get("set-cookie")).not.toMatch(/Domain=/i);
    }
  });
  it("reads the name that fits the transport and nothing else", async () => {
    const https = { "x-forwarded-proto": "https" };
    expect(await (await t.request("/read", { headers: { ...https, cookie: "__Host-runway_session=a" } })).text()).toBe("a");
    expect(await (await t.request("/read", { headers: { ...https, cookie: "runway_session=a" } })).text()).toBe("none");
    expect(await (await t.request("/read", { headers: { cookie: "runway_session=b" } })).text()).toBe("b");
    expect(await (await t.request("/read", { headers: { cookie: "__Host-runway_session=b" } })).text()).toBe("none");
  });
  it("is cleared with Max-Age=0", async () => {
    const r = await t.request("/clear", { headers: { "x-forwarded-proto": "https" } });
    expect(r.headers.getSetCookie().join("\n")).toMatch(/__Host-runway_session=;[^\n]*Max-Age=0/i);
  });
});
