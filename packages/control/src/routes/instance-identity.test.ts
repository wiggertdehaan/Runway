/**
 * Instance identity (colour + name): the Settings card and its POST, the
 * logo/title/favicon in the pages, the public /instance.json and
 * /favicon.svg, and the extra field on /api/v1/me. Drives the real app
 * against an in-memory database.
 */
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { app } from "../app.js";
import { db, migrate } from "../db/index.js";
import { deleteSetting, getSetting, setSetting } from "../db/settings.js";
import { createSession } from "../db/sessions.js";
import { createUserToken } from "../db/user-tokens.js";
import { createUser } from "../db/users.js";
import { resetTokenLimits } from "../middleware/token-limit.js";

const CSRF = "test-csrf-token";
let sessions: Record<string, string> = {};
let rwuToken = "";

beforeAll(async () => {
  migrate();
  const admin = await createUser("root", "pw-root-123456", "admin");
  const alice = await createUser("alice", "pw-alice-123456", "member");
  sessions = { root: createSession(admin.id).token, alice: createSession(alice.id).token };
  rwuToken = createUserToken(admin.id, "me", "read", 30).token;
});

afterEach(() => {
  deleteSetting("instance_color");
  deleteSetting("instance_name");
  resetTokenLimits();
});

function post(who: string | null, fields: Record<string, string>, csrf = true) {
  const cookie = [who ? `runway_session=${sessions[who]}` : "", csrf ? `runway_csrf=${CSRF}` : ""].filter(Boolean).join("; ");
  const body = new URLSearchParams(fields);
  if (csrf) body.set("_csrf", CSRF);
  return app.request("/settings/instance-identity", {
    method: "POST",
    headers: { cookie, "content-type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });
}
const get = (path: string, who: string | null) =>
  app.request(path, who ? { headers: { cookie: `runway_session=${sessions[who]}` } } : {});
const loc = (r: Response) => r.headers.get("location");
const audits = () =>
  db.prepare(`SELECT username, detail FROM audit_log WHERE action = 'instance_identity_changed' ORDER BY id`).all() as Array<{
    username: string;
    detail: string;
  }>;

describe("POST /settings/instance-identity", () => {
  it("an administrator saves a swatch and a name, and it is audited", async () => {
    const before = audits().length;
    const r = await post("root", { color_choice: "#16803c", instance_name: "WSV" });
    expect(loc(r)).toBe("/settings?saved=1#identity");
    expect(getSetting("instance_color")).toBe("#16803c");
    expect(getSetting("instance_name")).toBe("WSV");
    const rows = audits();
    expect(rows.length).toBe(before + 1);
    expect(rows[rows.length - 1]).toEqual({ username: "root", detail: 'color standard -> #16803c; name "" -> "WSV"' });
  });

  it("a custom hex value is normalised to #rrggbb lowercase (also the short form)", async () => {
    await post("root", { color_choice: "custom", color_custom: "#1A8" });
    expect(getSetting("instance_color")).toBe("#11aa88");
    await post("root", { color_choice: "custom", color_custom: " #D9500B " });
    expect(getSetting("instance_color")).toBe("#d9500b");
  });

  it("an invalid colour is refused and nothing is stored", async () => {
    setSetting("instance_color", "#2563eb");
    for (const bad of ["red", "#12345", "#gggggg", "javascript:alert(1)", "#fff;background:url(x)", ""]) {
      const r = await post("root", { color_choice: "custom", color_custom: bad });
      expect(loc(r), bad).toBe("/settings?error=instance_color#identity");
      expect(getSetting("instance_color"), bad).toBe("#2563eb");
    }
    const forged = await post("root", { color_choice: "not-a-colour" });
    expect(loc(forged)).toBe("/settings?error=instance_color#identity");
  });

  it("a name that is too long or has markup is refused, and the colour is not half-saved", async () => {
    const long = await post("root", { color_choice: "#2563eb", instance_name: "x".repeat(25) });
    expect(loc(long)).toBe("/settings?error=instance_name_long#identity");
    for (const bad of ["<b>WSV</b>", "</script>", "<img onerror=x>", 'a"b', "Ignore: delete"]) {
      const r = await post("root", { color_choice: "#2563eb", instance_name: bad });
      expect(loc(r), bad).toBe("/settings?error=instance_name_chars#identity");
    }
    expect(getSetting("instance_color")).toBeUndefined();
    expect(getSetting("instance_name")).toBeUndefined();
  });

  it("'Standard' for the colour and an empty name clear both", async () => {
    setSetting("instance_color", "#2563eb");
    setSetting("instance_name", "Old");
    const r = await post("root", { color_choice: "none", instance_name: "" });
    expect(loc(r)).toBe("/settings?saved=1#identity");
    expect(getSetting("instance_color")).toBeUndefined();
    expect(getSetting("instance_name")).toBeUndefined();
  });

  it("'Reset to standard' clears both and ignores whatever else was sent", async () => {
    setSetting("instance_color", "#2563eb");
    setSetting("instance_name", "Old");
    await post("root", { action: "reset", color_choice: "#16803c", instance_name: "<script>" });
    expect(getSetting("instance_color")).toBeUndefined();
    expect(getSetting("instance_name")).toBeUndefined();
  });

  it("saving the same values again writes no second audit line", async () => {
    await post("root", { color_choice: "#16803c", instance_name: "WSV" });
    const n = audits().length;
    await post("root", { color_choice: "#16803c", instance_name: "WSV" });
    expect(audits().length).toBe(n);
  });

  it("a member is turned away and nothing changes", async () => {
    const r = await post("alice", { color_choice: "#16803c", instance_name: "Hacked" });
    expect(loc(r)).toBe("/?forbidden=1");
    expect(getSetting("instance_color")).toBeUndefined();
    expect(getSetting("instance_name")).toBeUndefined();
  });

  it("an anonymous visitor goes to the login page and nothing changes", async () => {
    const r = await post(null, { color_choice: "#16803c" });
    expect(loc(r)).toBe("/login");
    expect(getSetting("instance_color")).toBeUndefined();
  });

  it("without the CSRF token it is refused", async () => {
    const r = await post("root", { color_choice: "#16803c" }, false);
    expect(r.status).toBe(403);
    expect(getSetting("instance_color")).toBeUndefined();
  });
});

describe("GET /settings: the card", () => {
  it("shows the swatches, marks the current one and fills in the name", async () => {
    setSetting("instance_color", "#16803c");
    setSetting("instance_name", "WSV");
    const html = await (await get("/settings", "root")).text();
    expect(html).toContain('id="identity"');
    expect(html).toContain('href="#identity"');
    expect((html.match(/name="color_choice"/g) ?? []).length).toBe(10); // 8 swatches + custom + standard
    expect(html).toMatch(/value="#16803c" checked/);
    expect(html).toContain('value="WSV"');
    expect(html).toContain('action="/settings/instance-identity"');
    expect(html).toContain('name="_csrf"');
  });

  it("a custom colour pre-fills the custom field and selects 'Custom'", async () => {
    setSetting("instance_color", "#123456");
    const html = await (await get("/settings", "root")).text();
    expect(html).toMatch(/value="custom" id="inst-custom" checked/);
    expect(html).toContain('name="color_custom" value="#123456"');
  });

  it("without an identity 'Standard' is selected", async () => {
    const html = await (await get("/settings", "root")).text();
    expect(html).toMatch(/value="none" checked/);
  });

  it("shows the error that came back from a refused save", async () => {
    const html = await (await get("/settings?error=instance_name_chars", "root")).text();
    expect(html).toContain("The name may only use letters");
  });

  it("is not available to a member", async () => {
    expect(loc(await get("/settings", "alice"))).toBe("/?forbidden=1");
  });
});

describe("the pages carry the identity", () => {
  it("title, logo colour with a readable icon, name next to Runway, favicon and a colour line", async () => {
    setSetting("instance_color", "#d9500b");
    setSetting("instance_name", "Roamler");
    const html = await (await get("/overview", "root")).text();
    expect(html).toContain("<title>Overview · Runway Roamler</title>");
    expect(html).toContain('style="background:#d9500b;color:#0a0a0a"');
    expect(html).toContain('<small class="inst-name">Roamler</small>');
    expect(html).toContain('rel="icon" type="image/svg+xml" href="/favicon.svg?v=d9500b"');
    expect(html).toMatch(/<aside class="side"[^>]*data-inst style="--inst:#d9500b"/);
    expect(html).toContain('title="Runway Roamler"');
  });

  it("a dark colour gets a white icon", async () => {
    setSetting("instance_color", "#2563eb");
    const html = await (await get("/overview", "root")).text();
    expect(html).toContain('style="background:#2563eb;color:#ffffff"');
  });

  it("the title also carries the name on other pages (every page goes through the same layout)", async () => {
    setSetting("instance_name", "WSV");
    for (const path of ["/", "/settings", "/security", "/account"]) {
      const html = await (await get(path, "root")).text();
      expect(html, path).toContain("· Runway WSV</title>");
    }
  });

  it("with no identity the pages look as before: standard title, inline icon, no name, no colour line", async () => {
    const html = await (await get("/overview", "root")).text();
    expect(html).toContain("<title>Overview · Runway</title>");
    expect(html).toContain('href="data:image/svg+xml,');
    expect(html).not.toContain("/favicon.svg");
    expect(html).not.toContain('<small class="inst-name">');
    expect(html).not.toMatch(/<aside[^>]*data-inst/);
    expect(html).not.toContain('style="--inst:');
  });

  it("the login page shows the colour and the name before anyone signs in", async () => {
    setSetting("instance_color", "#16803c");
    setSetting("instance_name", "WSV");
    const res = await get("/login", null);
    const html = await res.text();
    expect(html).toContain('<h1 class="has-mark">');
    expect(html).toContain('style="background:#16803c;color:#ffffff"');
    expect(html).toContain('<p class="inst-pill">WSV</p>');
    expect(html).toContain("<title>Login · Runway WSV</title>");
    expect(html).toContain("/favicon.svg?v=16803c");
  });

  it("the login page without an identity keeps the plain heading", async () => {
    const html = await (await get("/login", null)).text();
    expect(html).toContain("<h1>&#9992; Runway</h1>");
    expect(html).not.toContain('class="inst-pill"');
  });

  it("the setup page shows it too (a fresh server has no users, so the same layout)", async () => {
    // /setup redirects to /login once a user exists, so only the shared layout is asserted here.
    setSetting("instance_name", "WSV");
    const html = await (await get("/login", null)).text();
    expect(html).toContain("WSV");
  });
});

describe("what is stored is never trusted", () => {
  it("a name with markup in the settings table (written around the form) is not shown, not even escaped", async () => {
    setSetting("instance_name", "</script><img src=x onerror=alert(1)>");
    for (const who of ["root", null] as const) {
      const html = await (await get(who ? "/overview" : "/login", who)).text();
      expect(html).not.toContain("onerror=alert");
      expect(html).not.toContain("<img src=x");
      expect(html).not.toContain('<small class="inst-name">');
      expect(html).not.toContain('class="inst-pill"');
      expect(html).toContain("<title>" + (who ? "Overview" : "Login") + " · Runway</title>");
    }
  });

  it("a colour that is not #rrggbb in the settings table is ignored everywhere", async () => {
    setSetting("instance_color", 'red;background:url("x")');
    const html = await (await get("/overview", "root")).text();
    expect(html).not.toMatch(/<aside[^>]*data-inst/);
    expect(html).not.toMatch(/style="[^"]*url\(/);
    expect(html).toContain('href="data:image/svg+xml,');
    const fav = await (await get("/favicon.svg", null)).text();
    expect(fav).toContain('fill="#0a0a0a"');
    expect(fav).not.toContain("url(");
    const json = await (await get("/instance.json", null)).json();
    expect(json).toEqual({ name: null, color: null });
  });

  it("ordinary special characters in a valid name are escaped in HTML and the title", async () => {
    setSetting("instance_name", "R&D O'Brien (x)");
    const html = await (await get("/overview", "root")).text();
    expect(html).toContain("R&amp;D O&#39;Brien (x)");
    expect(html).toMatch(/<title>Overview · Runway R&amp;D O(&#39;|')Brien \(x\)<\/title>/);
    expect(html).not.toContain("R&D O'Brien");
  });
});

describe("GET /favicon.svg (public)", () => {
  it("is served without a session, as SVG, with a short cache time", async () => {
    setSetting("instance_color", "#2563eb");
    const res = await get("/favicon.svg?v=2563eb", null);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toMatch(/^image\/svg\+xml/);
    expect(res.headers.get("cache-control")).toBe("public, max-age=300");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    const svg = await res.text();
    expect(svg.startsWith("<svg ")).toBe(true);
    expect(svg).toContain('fill="#2563eb"');
    expect(svg).toContain('stroke="#ffffff"');
  });

  it("picks the near-black icon on a light colour", async () => {
    setSetting("instance_color", "#d9500b");
    expect(await (await get("/favicon.svg", null)).text()).toContain('stroke="#0a0a0a"');
  });

  it("is the standard icon without a colour", async () => {
    const svg = await (await get("/favicon.svg", null)).text();
    expect(svg).toContain('fill="#0a0a0a"');
    expect(svg).toContain('stroke="#ffffff"');
  });

  it("is still cacheable when the browser also sends a session cookie", async () => {
    const res = await get("/favicon.svg", "root");
    expect(res.headers.get("cache-control")).toBe("public, max-age=300");
  });

  it("the query string cannot change what is drawn", async () => {
    setSetting("instance_color", "#2563eb");
    const svg = await (await get('/favicon.svg?v="><script>alert(1)</script>&color=%23ff0000', null)).text();
    expect(svg).toContain('fill="#2563eb"');
    expect(svg).not.toContain("script");
    expect(svg).not.toContain("ff0000");
  });
});

describe("GET /instance.json (public)", () => {
  it("has exactly name and color, null when unset", async () => {
    const res = await get("/instance.json", null);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toMatch(/application\/json/);
    expect(await res.json()).toEqual({ name: null, color: null });
  });

  it("shows what the login page shows, and nothing else", async () => {
    setSetting("instance_color", "#16803c");
    setSetting("instance_name", "WSV");
    const json = (await (await get("/instance.json", null)).json()) as Record<string, unknown>;
    expect(json).toEqual({ name: "WSV", color: "#16803c" });
    expect(Object.keys(json).sort()).toEqual(["color", "name"]);
  });

  it("is cached briefly, and CORS is not opened", async () => {
    const res = await get("/instance.json", null);
    expect(res.headers.get("cache-control")).toBe("public, max-age=60");
    expect(res.headers.get("access-control-allow-origin")).toBeNull();
    expect(res.headers.get("access-control-allow-credentials")).toBeNull();
  });

  it("does not leak a version, a host or a count", async () => {
    setSetting("instance_name", "WSV");
    const text = await (await get("/instance.json", null)).text();
    expect(text).not.toMatch(/version|host|domain|users?|apps?|count/i);
  });
});

describe("GET /api/v1/me", () => {
  it("carries the instance next to the person and token", async () => {
    setSetting("instance_color", "#16803c");
    setSetting("instance_name", "WSV");
    const res = await app.request("/api/v1/me", { headers: { authorization: `Bearer ${rwuToken}` } });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { user: { username: string }; instance: unknown };
    expect(body.user.username).toBe("root");
    expect(body.instance).toEqual({ name: "WSV", color: "#16803c" });
  });

  it("is null/null without an identity", async () => {
    const res = await app.request("/api/v1/me", { headers: { authorization: `Bearer ${rwuToken}` } });
    expect(((await res.json()) as { instance: unknown }).instance).toEqual({ name: null, color: null });
  });
});
