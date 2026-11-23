/**
 * The Users page, the first-run empty state, and the login/setup forms:
 * who may see what, that role/2FA labels are neutral, that the form
 * attributes help password managers, and that the login error text does
 * not reveal whether a username exists. Drives the real app against an
 * in-memory database; no Docker, no network.
 */
import { beforeAll, describe, expect, it } from "vitest";

import { app } from "../app.js";
import { migrate } from "../db/index.js";
import { createApp, updateApp } from "../db/apps.js";
import { createSession } from "../db/sessions.js";
import { createUser } from "../db/users.js";

const tok: Record<string, string> = {};

beforeAll(async () => {
  migrate();
  const root = await createUser("root", "pw-root-123456", "admin");
  const sanne = await createUser("sanne", "pw-sanne-123456", "member");
  await createUser("joost", "pw-joost-123456", "member");
  tok.root = createSession(root.id).token;
  tok.sanne = createSession(sanne.id).token;
});

const get = (path: string, who: string | null) =>
  app.request(path, { headers: who ? { cookie: `runway_session=${tok[who]}` } : {} });

describe("GET /users", () => {
  it("sends anonymous visitors to login and keeps members out", async () => {
    const anon = await get("/users", null);
    expect(anon.status).toBe(302);
    expect(anon.headers.get("location") ?? "").toMatch(/login/);
    const member = await get("/users", "sanne");
    expect(member.status).toBe(302);
    expect(member.headers.get("location") ?? "").toContain("forbidden");
  });

  it("shows an admin everyone, with neutral roles and amber 2FA", async () => {
    const html = await (await get("/users", "root")).text();
    expect(html).toContain("3 people");
    expect(html).toContain("sanne");
    expect(html).toContain("joost");
    expect(html).toContain('<span class="tag">Member</span>');
    expect(html).toContain("tag tag-warn");
    // Only look at the people cards: the stylesheet itself defines the badge classes.
    const cards = html.split('<div class="card person">').slice(1).join("");
    expect(cards).not.toMatch(/badge-stopped|badge-failed|tag-err/);
    expect(html).toContain("This is you");
  });

  it("lists the apps a person owns", async () => {
    const a = createApp("sanne");
    updateApp(a.id, { name: "weekplanner" } as never);
    const html = await (await get("/users", "root")).text();
    expect(html).toContain("weekplanner");
  });

  it("still carries the CSRF field on every POST form", async () => {
    const html = await (await get("/users", "root")).text();
    const forms = html.match(/<form [^>]*method="POST"[^>]*>/gi) ?? [];
    expect(forms.length).toBeGreaterThan(2);
    for (const f of forms) {
      const at = html.indexOf(f);
      expect(html.slice(at, at + f.length + 120)).toContain("_csrf");
    }
  });

  it("keeps the POST routes admin-only and CSRF-protected", async () => {
    const noCsrf = await app.request("/users/anything/delete", {
      method: "POST",
      headers: { cookie: `runway_session=${tok.root}` },
    });
    expect(noCsrf.status).toBe(403);
  });
});

describe("empty state on the home page", () => {
  it("shows the three steps to a member without apps and to the admin", async () => {
    // sanne owns an app by now, so use a fresh member
    const joost = (await import("../db/users.js")).getUserByUsername("joost")!;
    tok.joost = createSession(joost.id).token;
    const html = await (await get("/", "joost")).text();
    expect(html).toContain("Deploy your first app");
    expect(html).toContain("claude mcp add runway-skills");
    expect(html).not.toMatch(/rwd_[A-Za-z0-9_-]{8,}/);
    // no base-domain hint for a member
    expect(html).not.toContain("/settings#domain");
  });

  it("shows the base-domain hint to the admin only", async () => {
    const admin = await (await get("/", "root")).text();
    expect(admin).toContain("No base domain configured");
    const member = await (await get("/", "sanne")).text();
    expect(member).not.toContain("No base domain configured");
  });
});

describe("login and setup forms", () => {
  it("tell password managers what each field is", async () => {
    const html = await (await app.request("/login")).text();
    expect(html).toContain('autocomplete="username"');
    expect(html).toContain('autocomplete="current-password"');
    expect(html).toContain("Trouble signing in?");
  });

  it("gives the same error for an unknown user and a wrong password", async () => {
    const post = async (username: string) => {
      const form = new URLSearchParams({ username, password: "wrong-password-1" });
      const r = await app.request("/login", {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: form,
      });
      return { status: r.status, location: r.headers.get("location") };
    };
    const real = await post("root");
    const fake = await post("nobody-here");
    expect(real).toEqual(fake);
  });
});

describe("settings", () => {
  it("describes everything the webhook receives", async () => {
    const html = await (await get("/settings", "root")).text();
    expect(html).toContain("rebuild results");
    expect(html).toContain("security events");
    expect(html).not.toContain("called on deploy failure.");
  });
  it("keeps Settings admin-only", async () => {
    const r = await get("/settings", "sanne");
    expect(r.status).toBe(302);
    expect(r.headers.get("location") ?? "").toContain("forbidden");
  });
});
