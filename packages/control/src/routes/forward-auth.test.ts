/**
 * S05: /auth/verify is the only thing between the internet and an SSO app, so
 * it is driven through the real app: anything unclear is refused, never "OK".
 */
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { app } from "../app.js";
import { db, migrate } from "../db/index.js";
import { createApp, updateApp } from "../db/apps.js";
import { createUser, setUserEmail } from "../db/users.js";
import { createSession } from "../db/sessions.js";
import { setSetting } from "../db/settings.js";
import { setAppAllowedEmails } from "../db/app-emails.js";

let tok = "";
let strangerTok = "";
let ssoApp = { id: "", key: "" };
let otherApp = { id: "", key: "" };

beforeAll(async () => {
  migrate();
  process.env.DASHBOARD_DOMAIN = "runway.example.com";
  const sam = await createUser("sam", "pw-sam-123456", "member");
  setUserEmail(sam.id, "sam@corp.example");
  tok = createSession(sam.id).token;
  const eve = await createUser("eve", "pw-eve-123456", "member");
  setUserEmail(eve.id, "eve@corp.example");
  strangerTok = createSession(eve.id).token;
});

beforeEach(() => {
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

function verify(host: string | undefined, cookie?: string) {
  const headers: Record<string, string> = { "x-forwarded-proto": "https", "x-forwarded-uri": "/dash" };
  if (host !== undefined) headers["x-forwarded-host"] = host;
  if (cookie) headers.cookie = `runway_session=${cookie}`;
  return app.request("/auth/verify", { headers });
}

describe("GET /auth/verify fails closed", () => {
  it("lets an allowed member through on the app's own host and sets the user header", async () => {
    const r = await verify("shop.apps.example.com", tok);
    expect(r.status).toBe(200);
    expect(r.headers.get("x-forwarded-user")).toBe("sam@corp.example");
  });

  it("sends an anonymous visitor to log in", async () => {
    const r = await verify("shop.apps.example.com");
    expect(r.status).toBe(302);
    expect(r.headers.get("location")).toContain("/login?return_to=");
    expect(decodeURIComponent(r.headers.get("location")!)).toContain("https://shop.apps.example.com/dash");
  });

  it("refuses a request without a forwarded host (it used to be waved through)", async () => {
    const r = await verify(undefined, tok);
    expect(r.status).toBe(403);
  });

  it("refuses a host that belongs to no app", async () => {
    expect((await verify("ghost.apps.example.com", tok)).status).toBe(403);
    expect((await verify("ghost.apps.example.com")).status).toBe(403);
  });

  it("refuses an app that has SSO switched off, so a stale router cannot open it", async () => {
    expect((await verify("plain.apps.example.com", tok)).status).toBe(403);
    expect((await verify("plain.apps.example.com")).status).toBe(403);
  });

  it("refuses the custom domain of an SSO app, signed in or not, without a login loop", async () => {
    for (const cookie of [tok, undefined]) {
      const r = await verify("www.shop.test", cookie);
      expect(r.status).toBe(403);
      expect(await r.text()).toMatch(/custom domain/i);
      expect(r.headers.get("location")).toBeNull();
    }
  });

  it("refuses a signed-in user who is not on the app's allowlist", async () => {
    expect((await verify("shop.apps.example.com", strangerTok)).status).toBe(403);
  });

  it("treats the host case-insensitively and ignores a port", async () => {
    expect((await verify("SHOP.apps.example.com:443", tok)).status).toBe(200);
  });

  it("refuses when the database lookup throws", async () => {
    db.exec("ALTER TABLE apps RENAME TO apps_gone");
    try {
      const r = await verify("shop.apps.example.com", tok);
      expect(r.status).toBe(403);
    } finally {
      db.exec("ALTER TABLE apps_gone RENAME TO apps");
    }
  });
});

describe("API warns when SSO and a custom domain meet", () => {
  const put = (path: string, key: string, body: unknown) =>
    app.request(`/api/v1${path}`, {
      method: "PUT",
      headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
      body: JSON.stringify(body),
    });

  it("on PUT /app/sso for an app with a custom domain", async () => {
    const r = await put("/app/sso", ssoApp.key, { enabled: true });
    expect(r.status).toBe(200);
    expect((await r.json()).warning).toMatch(/custom domain/i);
  });

  it("on PUT /app/domain for an SSO app", async () => {
    const r = await put("/app/domain", ssoApp.key, { custom_domain: "shop2.example.org" });
    expect(r.status).toBe(200);
    expect((await r.json()).warning).toMatch(/SSO/);
  });

  it("not when SSO is off or there is no custom domain", async () => {
    const r = await put("/app/sso", otherApp.key, { enabled: false });
    expect((await r.json()).warning).toBeUndefined();
  });
});
