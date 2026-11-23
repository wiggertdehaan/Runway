/**
 * S23: /auth/verify and /maintenance are for Traefik. Addressed to the
 * dashboard's own host (which is how a visitor on the internet would reach
 * them) they answer 404 and reveal nothing; addressed the way Traefik does it
 * they keep working. Drives the real app.
 */
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { app } from "../app.js";
import { db, migrate } from "../db/index.js";
import { createApp, updateApp } from "../db/apps.js";
import { createUser, setUserEmail } from "../db/users.js";
import { createSession } from "../db/sessions.js";
import { setSetting } from "../db/settings.js";
import { setAppAllowedEmails } from "../db/app-emails.js";
import { isDashboardHost, isInternalRoute, requestHost } from "../middleware/internal-routes.js";

const DASH = "runway.example.com";
let samId = "";

beforeAll(async () => {
  migrate();
  process.env.DASHBOARD_DOMAIN = DASH;
  const sam = await createUser("sam", "pw-sam-123456", "member");
  setUserEmail(sam.id, "sam@corp.example");
  samId = sam.id;
});

beforeEach(() => {
  db.exec("DELETE FROM apps");
  setSetting("base_domain", "apps.example.com");
  const a = createApp("sam");
  updateApp(a.id, { domain: "shop.apps.example.com", sso_enabled: 1 });
  setAppAllowedEmails(a.id, ["sam@corp.example"]);
  createSession(samId);
});

const verify = (host: string, forwardedHost = "shop.apps.example.com") =>
  app.request(`http://${host}/auth/verify`, {
    headers: {
      host,
      "x-forwarded-host": forwardedHost,
      "x-forwarded-uri": "/",
      "x-forwarded-proto": "https",
    },
  });
const maintenance = (host: string) => app.request(`http://${host}/maintenance`, { headers: { host } });

describe("/auth/verify", () => {
  it("is not served on the dashboard host, whatever X-Forwarded-Host the visitor sends", async () => {
    for (const forwarded of ["shop.apps.example.com", "nothing.example.org", DASH]) {
      const r = await verify(DASH, forwarded);
      expect(r.status, forwarded).toBe(404);
      expect(await r.text()).toBe("Not found");
      expect(r.headers.get("location")).toBeNull();
      expect(r.headers.get("x-forwarded-user")).toBeNull();
    }
  });

  it("answers a known SSO host and an unknown one differently NOWHERE on the dashboard host", async () => {
    const known = await verify(DASH, "shop.apps.example.com");
    const unknown = await verify(DASH, "nope.example.org");
    expect(known.status).toBe(unknown.status);
    expect(await known.text()).toBe(await unknown.text());
  });

  it("also covers case, a port, a trailing dot and a trailing slash", async () => {
    for (const host of [DASH.toUpperCase(), `${DASH}:443`, `${DASH}.`]) {
      expect((await verify(host)).status, host).toBe(404);
    }
    const r = await app.request(`http://${DASH}/auth/verify/`, { headers: { host: DASH } });
    expect(r.status).toBe(404);
  });

  it("still works the way Traefik's forwardAuth calls it (Host is control:3000)", async () => {
    const r = await verify("control:3000");
    // No session: sent to sign in, which is the normal answer. Not a 404.
    expect(r.status).toBe(302);
    expect(r.headers.get("location") ?? "").toContain("/sso/start");
  });

  it("still refuses an unknown host the same fail-closed way when called internally", async () => {
    const r = await verify("control:3000", "nope.example.org");
    expect(r.status).toBe(403);
  });
});

describe("/maintenance", () => {
  it("is not served on the dashboard host", async () => {
    const r = await maintenance(DASH);
    expect(r.status).toBe(404);
    expect(r.headers.get("retry-after")).toBeNull();
  });

  it("is served for an app's own host, which is how the quarantine rewrite reaches it", async () => {
    const r = await maintenance("shop.apps.example.com");
    expect(r.status).toBe(503);
    expect(await r.text()).toContain("Temporarily offline");
    expect(r.headers.get("retry-after")).toBe("3600");
  });
});

describe("the rest of the dashboard host is untouched", () => {
  it("serves the login page", async () => {
    const r = await app.request(`http://${DASH}/login`, { headers: { host: DASH } });
    expect([200, 302]).toContain(r.status);
  });
  it("serves /llms.txt", async () => {
    const r = await app.request(`http://${DASH}/llms.txt`, { headers: { host: DASH } });
    expect(r.status).toBe(200);
  });
});

describe("pure helpers", () => {
  it("isInternalRoute matches exactly the two paths", () => {
    expect(isInternalRoute("/auth/verify")).toBe(true);
    expect(isInternalRoute("/auth/verify/")).toBe(true);
    expect(isInternalRoute("/maintenance")).toBe(true);
    expect(isInternalRoute("/auth/verify2")).toBe(false);
    expect(isInternalRoute("/auth/google/callback")).toBe(false);
    expect(isInternalRoute("/maintenance/x")).toBe(false);
  });
  it("requestHost prefers the Host header and falls back to the URL", () => {
    expect(requestHost("Runway.Example.com:443", "http://other/")).toBe("runway.example.com");
    expect(requestHost(undefined, "http://runway.example.com:3000/x")).toBe("runway.example.com");
    expect(requestHost(undefined, "not a url")).toBe("");
  });
  it("isDashboardHost is off when no dashboard domain is configured", () => {
    expect(isDashboardHost("runway.example.com", undefined)).toBe(false);
    expect(isDashboardHost("", "")).toBe(false);
    expect(isDashboardHost("runway.example.com", "Runway.Example.com")).toBe(true);
    expect(isDashboardHost("control", "runway.example.com")).toBe(false);
  });
});
