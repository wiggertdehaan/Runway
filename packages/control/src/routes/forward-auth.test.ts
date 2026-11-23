/**
 * S05 + S02: /auth/verify is the only thing between the internet and an SSO
 * app, so it is driven through the real app: anything unclear is refused,
 * never "OK". The app host has its own sign-in (ticket handshake), separate
 * from the dashboard session, which an app host never receives.
 */
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { app } from "../app.js";
import { db, migrate } from "../db/index.js";
import { createApp, updateApp } from "../db/apps.js";
import { createUser, setUserEmail } from "../db/users.js";
import { createSession, deleteSession, deleteAllUserSessions } from "../db/sessions.js";
import { createSsoTicket, getSsoSession, hashToken } from "../db/sso-sessions.js";
import { setSetting } from "../db/settings.js";
import { setAppAllowedEmails } from "../db/app-emails.js";

let tok = "";
let strangerTok = "";
let samId = "";
let eveId = "";
let ssoApp = { id: "", key: "" };
let otherApp = { id: "", key: "" };

beforeAll(async () => {
  migrate();
  process.env.DASHBOARD_DOMAIN = "runway.example.com";
  const sam = await createUser("sam", "pw-sam-123456", "member");
  setUserEmail(sam.id, "sam@corp.example");
  samId = sam.id;
  tok = createSession(sam.id).token;
  const eve = await createUser("eve", "pw-eve-123456", "member");
  setUserEmail(eve.id, "eve@corp.example");
  eveId = eve.id;
});

beforeEach(() => {
  // Some tests end every session of the user, so each one starts with its own.
  tok = createSession(samId).token;
  strangerTok = createSession(eveId).token;
  db.exec("DELETE FROM apps");
  setSetting("base_domain", "apps.example.com");
  const a = createApp("sam");
  ssoApp = { id: a.id, key: a.api_key };
  updateApp(a.id, { domain: "shop.apps.example.com", custom_domain: "www.shop.test", sso_enabled: 1 });
  setAppAllowedEmails(a.id, ["sam@corp.example"]);
  const b = createApp("sam");
  otherApp = { id: b.id, key: b.api_key };
  updateApp(b.id, { domain: "plain.apps.example.com", sso_enabled: 0 });
});

const HOST = "shop.apps.example.com";

function verify(host: string | undefined, cookie?: string, uri = "/dash") {
  const headers: Record<string, string> = { "x-forwarded-proto": "https", "x-forwarded-uri": uri };
  if (host !== undefined) headers["x-forwarded-host"] = host;
  if (cookie) headers.cookie = cookie;
  return app.request("/auth/verify", { headers });
}

const ssoCookie = (token: string) => `__Host-runway_sso=${token}`;

/** Run the whole handshake for `host` as the user behind `dashboardToken`; returns the app-host cookie value. */
async function signInOn(host: string, dashboardToken: string, uri = "/dash"): Promise<string> {
  const start = await app.request(
    `/sso/start?host=${encodeURIComponent(host)}&uri=${encodeURIComponent(uri)}`,
    { headers: { cookie: `runway_session=${dashboardToken}` } }
  );
  expect(start.status).toBe(302);
  const target = new URL(start.headers.get("location")!);
  expect(target.host).toBe(host);
  const redeem = await verify(host, undefined, target.pathname + target.search);
  expect(redeem.status).toBe(302);
  const setCookie = redeem.headers.get("set-cookie")!;
  return /__Host-runway_sso=([^;]+)/.exec(setCookie)![1];
}

describe("GET /auth/verify fails closed", () => {
  it("lets an allowed member through on the app's own host after the handshake, and sets the user header", async () => {
    const t = await signInOn(HOST, tok);
    const r = await verify(HOST, ssoCookie(t));
    expect(r.status).toBe(200);
    expect(r.headers.get("x-forwarded-user")).toBe("sam@corp.example");
  });

  it("works on the custom domain too (the app cookie is host-only, so that is safe)", async () => {
    const t = await signInOn("www.shop.test", tok);
    expect((await verify("www.shop.test", ssoCookie(t))).status).toBe(200);
  });

  it("sends an anonymous visitor to the dashboard handshake, carrying host and path", async () => {
    const r = await verify(HOST);
    expect(r.status).toBe(302);
    const loc = new URL(r.headers.get("location")!);
    expect(loc.pathname).toBe("/sso/start");
    expect(loc.searchParams.get("host")).toBe(HOST);
    expect(loc.searchParams.get("uri")).toBe("/dash");
  });

  it("does not accept the dashboard session cookie on an app host", async () => {
    for (const cookie of [`runway_session=${tok}`, `__Host-runway_session=${tok}`]) {
      const r = await verify(HOST, cookie);
      expect(r.status).toBe(302);
      expect(r.headers.get("x-forwarded-user")).toBeNull();
    }
  });

  it("refuses a request without a forwarded host (it used to be waved through)", async () => {
    expect((await verify(undefined, ssoCookie("x"))).status).toBe(403);
  });

  it("refuses a host that belongs to no app", async () => {
    expect((await verify("ghost.apps.example.com")).status).toBe(403);
  });

  it("refuses an app that has SSO switched off, so a stale router cannot open it", async () => {
    expect((await verify("plain.apps.example.com")).status).toBe(403);
  });

  it("refuses a signed-in user who is not on the app's allowlist, already at the handshake", async () => {
    const r = await app.request(`/sso/start?host=${HOST}&uri=%2F`, {
      headers: { cookie: `runway_session=${strangerTok}` },
    });
    expect(r.status).toBe(403);
  });

  it("treats the host case-insensitively and ignores a port", async () => {
    const t = await signInOn(HOST, tok);
    expect((await verify("SHOP.apps.example.com:443", ssoCookie(t))).status).toBe(200);
  });

  it("refuses when the database lookup throws", async () => {
    const t = await signInOn(HOST, tok);
    db.exec("ALTER TABLE apps RENAME TO apps_gone");
    try {
      expect((await verify(HOST, ssoCookie(t))).status).toBe(403);
    } finally {
      db.exec("ALTER TABLE apps_gone RENAME TO apps");
    }
  });
});

describe("app cookie is bound to its host and to the dashboard session", () => {
  it("is useless on another app's host", async () => {
    const t = await signInOn(HOST, tok);
    const other = createApp("sam");
    updateApp(other.id, { domain: "other.apps.example.com", sso_enabled: 1 });
    setAppAllowedEmails(other.id, ["sam@corp.example"]);
    const r = await verify("other.apps.example.com", ssoCookie(t));
    expect(r.status).toBe(302);
  });

  it("is useless on the dashboard: only a dashboard session opens the dashboard", async () => {
    const t = await signInOn(HOST, tok);
    for (const name of ["runway_session", "__Host-runway_session", "runway_sso"]) {
      const r = await app.request("/", { headers: { cookie: `${name}=${t}`, "x-forwarded-proto": name.startsWith("__") ? "https" : "http" } });
      expect(r.status).toBe(302);
      expect(r.headers.get("location")).toBe("/login");
    }
  });

  it("dies with the dashboard session (sign out)", async () => {
    const own = createSession(samId).token;
    const t = await signInOn(HOST, own);
    expect((await verify(HOST, ssoCookie(t))).status).toBe(200);
    const out = await app.request("/logout", {
      method: "POST",
      headers: { cookie: `runway_session=${own}; runway_csrf=c`, "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ _csrf: "c" }).toString(),
    });
    expect(out.status).toBe(302);
    expect((await verify(HOST, ssoCookie(t))).status).toBe(302);
    expect(getSsoSession(t, HOST)).toBeUndefined();
  });

  it("dies when all sessions of the user are ended (password change, reset)", async () => {
    const own = createSession(samId).token;
    const t = await signInOn(HOST, own);
    deleteAllUserSessions(samId);
    expect((await verify(HOST, ssoCookie(t))).status).toBe(302);
  });

  it("dies when the dashboard session expires", async () => {
    const own = createSession(samId).token;
    const t = await signInOn(HOST, own);
    db.prepare("UPDATE sessions SET expires_at = '2000-01-01T00:00:00.000Z' WHERE token = ?").run(own);
    expect((await verify(HOST, ssoCookie(t))).status).toBe(302);
  });

  it("stops working when the user is removed from the app's allowlist", async () => {
    const t = await signInOn(HOST, tok);
    setAppAllowedEmails(ssoApp.id, ["someone.else@corp.example"]);
    expect((await verify(HOST, ssoCookie(t))).status).toBe(403);
  });

  it("is stored hashed", async () => {
    const t = await signInOn(HOST, tok);
    const rows = db.prepare("SELECT hash FROM sso_sessions").all() as Array<{ hash: string }>;
    expect(rows.some((r) => r.hash === hashToken(t))).toBe(true);
    expect(rows.some((r) => r.hash === t)).toBe(false);
  });
});

describe("the ticket handshake", () => {
  const redeem = (host: string, ticket: string, uri = "/dash") =>
    verify(host, undefined, `${uri}${uri.includes("?") ? "&" : "?"}__runway_ticket=${ticket}`);

  it("is single use", async () => {
    const tk = createSsoTicket({ host: HOST, appId: ssoApp.id, userId: samId, dashboardToken: tok });
    expect((await redeem(HOST, tk)).status).toBe(302);
    const again = await redeem(HOST, tk);
    expect(again.status).toBe(403);
    expect(again.headers.get("set-cookie")).toBeNull();
  });

  it("is bound to the host it was issued for", async () => {
    const tk = createSsoTicket({ host: HOST, appId: ssoApp.id, userId: samId, dashboardToken: tok });
    const r = await redeem("www.shop.test", tk);
    expect(r.status).toBe(403);
    expect(r.headers.get("set-cookie")).toBeNull();
  });

  it("expires after a minute", async () => {
    createSsoTicket({ host: HOST, appId: ssoApp.id, userId: samId, dashboardToken: tok, now: Date.now() - 61_000 });
    const tk = createSsoTicket({ host: HOST, appId: ssoApp.id, userId: samId, dashboardToken: tok, now: Date.now() - 61_000 });
    expect((await redeem(HOST, tk)).status).toBe(403);
  });

  it("is refused when the dashboard session it came from is gone", async () => {
    const own = createSession(samId).token;
    const tk = createSsoTicket({ host: HOST, appId: ssoApp.id, userId: samId, dashboardToken: own });
    deleteSession(own);
    expect((await redeem(HOST, tk)).status).toBe(403);
  });

  it("is refused when it is made up", async () => {
    expect((await redeem(HOST, "forged")).status).toBe(403);
  });

  it("sets a host-only, HttpOnly, Secure cookie with no Domain and cleans the URL", async () => {
    const tk = createSsoTicket({ host: HOST, appId: ssoApp.id, userId: samId, dashboardToken: tok });
    const r = await redeem(HOST, tk, "/dash?tab=2");
    expect(r.status).toBe(302);
    expect(r.headers.get("location")).toBe(`https://${HOST}/dash?tab=2`);
    const c = r.headers.get("set-cookie")!;
    expect(c).toMatch(/^__Host-runway_sso=/);
    expect(c).toMatch(/HttpOnly/i);
    expect(c).toMatch(/Secure/i);
    expect(c).toMatch(/Path=\//);
    expect(c).not.toMatch(/Domain=/i);
    expect(c).toMatch(/Max-Age=28800/);
  });

  it("/sso/start refuses a host that is not an SSO app (no open redirect)", async () => {
    for (const host of ["evil.example", "plain.apps.example.com", "ghost.apps.example.com", ""]) {
      const r = await app.request(`/sso/start?host=${encodeURIComponent(host)}&uri=%2F`, {
        headers: { cookie: `runway_session=${tok}` },
      });
      expect(r.status).toBe(403);
      expect(r.headers.get("location")).toBeNull();
    }
  });

  it("/sso/start never redirects off the app host, whatever uri says", async () => {
    for (const uri of ["https://evil.example/", "//evil.example/x", "/\\evil.example"]) {
      const r = await app.request(`/sso/start?host=${HOST}&uri=${encodeURIComponent(uri)}`, {
        headers: { cookie: `runway_session=${tok}` },
      });
      expect(r.status).toBe(302);
      const loc = new URL(r.headers.get("location")!);
      expect(loc.host).toBe(HOST);
      expect(loc.pathname).toBe("/");
    }
  });

  it("/sso/start sends an anonymous visitor to log in, and the login returns to the handshake", async () => {
    const r = await app.request(`/sso/start?host=${HOST}&uri=%2Fdash`);
    expect(r.status).toBe(302);
    const loc = r.headers.get("location")!;
    expect(loc.startsWith("/login?return_to=")).toBe(true);
    expect(decodeURIComponent(loc.split("return_to=")[1])).toBe(`/sso/start?host=${HOST}&uri=%2Fdash`);
  });
});

describe("dashboard session cookie is host-only", () => {
  const loginForm = (extra: Record<string, string> = {}) => ({
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", "x-forwarded-proto": "https", ...extra },
  });

  it("has no Domain, is __Host- prefixed, HttpOnly, Secure, SameSite=Lax over HTTPS", async () => {
    const csrf = "csrf-test-token";
    const r = await app.request("/login", {
      ...loginForm({ cookie: `__Host-runway_csrf=${csrf}` }),
      body: new URLSearchParams({ username: "sam", password: "pw-sam-123456", _csrf: csrf }).toString(),
    });
    expect(r.status).toBe(302);
    const c = r.headers.get("set-cookie")!;
    expect(c).toMatch(/__Host-runway_session=/);
    expect(c).not.toMatch(/Domain=/i);
    expect(c).toMatch(/HttpOnly/i);
    expect(c).toMatch(/Secure/i);
    expect(c).toMatch(/SameSite=Lax/i);
    expect(c).toMatch(/Path=\//);
  });

  it("is not set with a Domain even when a base domain is configured", async () => {
    setSetting("base_domain", "apps.example.com");
    const csrf = "csrf-test-token";
    const r = await app.request("/login", {
      ...loginForm({ cookie: `__Host-runway_csrf=${csrf}` }),
      body: new URLSearchParams({ username: "sam", password: "pw-sam-123456", _csrf: csrf }).toString(),
    });
    const all = r.headers.getSetCookie().join("\n");
    expect(all).not.toMatch(/Domain=/i);
  });

  it("over HTTPS ignores a plain-named cookie (a subdomain cannot plant a session)", async () => {
    const r = await app.request("/", {
      headers: { cookie: `runway_session=${tok}`, "x-forwarded-proto": "https" },
    });
    expect(r.status).toBe(302);
    expect(r.headers.get("location")).toBe("/login");
  });

  it("over HTTPS accepts the prefixed cookie", async () => {
    const r = await app.request("/", {
      headers: { cookie: `__Host-runway_session=${tok}`, "x-forwarded-proto": "https" },
    });
    expect(r.status).toBe(200);
  });

  it("tells a browser that still holds the old domain-wide cookie to drop it", async () => {
    setSetting("base_domain", "apps.example.com");
    const r = await app.request("/login", {
      headers: { cookie: "runway_session=old", "x-forwarded-proto": "https" },
    });
    const all = r.headers.getSetCookie().join("\n");
    expect(all).toMatch(/runway_session=;[^\n]*Max-Age=0/i);
    expect(all).toMatch(/Domain=\.apps\.example\.com/i);
  });

  it("logout clears the cookie", async () => {
    const own = createSession(samId).token;
    const r = await app.request("/logout", {
      method: "POST",
      headers: { cookie: `__Host-runway_session=${own}; __Host-runway_csrf=c`, "content-type": "application/x-www-form-urlencoded", "x-forwarded-proto": "https" },
      body: new URLSearchParams({ _csrf: "c" }).toString(),
    });
    expect(r.status).toBe(302);
    expect(r.headers.getSetCookie().join("\n")).toMatch(/__Host-runway_session=;[^\n]*Max-Age=0/i);
    expect(db.prepare("SELECT 1 FROM sessions WHERE token = ?").get(own)).toBeUndefined();
  });
});

describe("sessions are ended once on upgrade", () => {
  it("drops every dashboard session the first time, then leaves them alone", () => {
    createSession(samId);
    db.prepare("DELETE FROM settings WHERE key = 'sessions_host_only_v1'").run();
    migrate();
    expect((db.prepare("SELECT COUNT(*) AS n FROM sessions").get() as { n: number }).n).toBe(0);
    createSession(samId);
    migrate();
    expect((db.prepare("SELECT COUNT(*) AS n FROM sessions").get() as { n: number }).n).toBe(1);
  });
});
