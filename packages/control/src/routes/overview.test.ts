/**
 * GET /overview: who sees what, with the real app (sessions, CSRF layer,
 * layout) over an in-memory database. No Docker and no network: the server
 * health check is replaced by a fixed answer.
 */
import { beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("../overview/health.js", async (orig) => {
  const real = await orig<typeof import("../overview/health.js")>();
  return { ...real, cachedHealth: async () => ({ total: 8, failed: ["Traefik"] }) };
});

import { app } from "../app.js";
import { bumpRequest } from "../db/activity.js";
import { createApp, updateApp } from "../db/apps.js";
import { emitEvent } from "../db/events.js";
import { migrate } from "../db/index.js";
import { saveQuarantine, setExemption } from "../db/quarantine.js";
import { createSession } from "../db/sessions.js";
import { createUserToken } from "../db/user-tokens.js";
import { createUser } from "../db/users.js";

const DAY = 86_400_000;
let sessions: Record<string, string> = {};
const ids: Record<string, string> = {};

beforeAll(async () => {
  migrate();
  const admin = await createUser("root", "pw-root-123456", "admin");
  const alice = await createUser("alice", "pw-alice-123456", "member");
  const bob = await createUser("bob", "pw-bob-123456", "member");
  const carol = await createUser("carol", "pw-carol-123456", "member");
  sessions = {
    root: createSession(admin.id).token,
    alice: createSession(alice.id).token,
    bob: createSession(bob.id).token,
    carol: createSession(carol.id).token,
  };
  const mk = (key: string, owner: string | undefined, name: string) => {
    const a = createApp(owner);
    updateApp(a.id, { name, runtime: "node", status: "running", image_tag: `runway/${key}:1` } as never);
    ids[key] = a.id;
  };
  mk("alice1", "alice", "alice-shop");
  mk("alice2", "alice", "alice-blog");
  mk("bob1", "bob", "bob-crm");
  mk("orphan", undefined, "nobody-app");

  // bob's app is in a KEV term; alice's blog has an exemption that ends soon.
  saveQuarantine({
    app_id: ids.bob1,
    state: "grace",
    kev_first_seen: { "CVE-2026-7777": new Date(Date.now() - 2 * DAY).toISOString() },
    attempt_at: null,
    quarantined_at: null,
  });
  setExemption({ app_id: ids.alice2, reason: "waiting for the vendor", until: new Date(Date.now() + 2 * DAY).toISOString(), granted_by: "root" });

  // events: alice 1 deploy ok, bob 2 deploys ok + 1 failed, a rebuild for bob
  emitEvent({ appId: ids.alice1, code: "deploy_succeeded" });
  emitEvent({ appId: ids.bob1, code: "deploy_succeeded" });
  emitEvent({ appId: ids.bob1, code: "deploy_succeeded" });
  emitEvent({ appId: ids.bob1, code: "deploy_failed:build" });
  emitEvent({ appId: ids.bob1, code: "kev_grace_started" });

  // hits: bob gets far more traffic than alice
  const now = Date.now();
  for (let i = 0; i < 7; i++) bumpRequest(ids.alice1, new Date(now - 3600_000));
  for (let i = 0; i < 90; i++) bumpRequest(ids.bob1, new Date(now - 3600_000));

  // tokens: bob has one that runs out in 3 days, alice one in 60
  createUserToken(bob.id, "bob-ci", "read", 3);
  createUserToken(alice.id, "alice-laptop", "read", 60);
});

const get = (path: string, who: string | null) =>
  app.request(path, { headers: who ? { cookie: `runway_session=${sessions[who]}` } : {} });

/** The hits card, as text. */
const hitsCard = (html: string) => html.match(/<div class="ov-stat" data-stat="hits">[\s\S]*?<\/div>\s*<\/div>|<div class="ov-stat" data-stat="hits">[\s\S]*?<\/ul>\s*<\/div>/)![0];
const statValue = (html: string, key: string) =>
  Number(html.match(new RegExp(`data-stat="${key}">\\s*<span class="ov-l">[^<]*</span>\\s*<span class="ov-v">([\\d,]+)</span>`))![1]!.replace(/,/g, ""));

describe("GET /overview", () => {
  it("sends an anonymous visitor to the login page", async () => {
    const r = await get("/overview", null);
    expect(r.status).toBe(302);
    expect(r.headers.get("location") ?? "").toMatch(/login/);
  });

  it("shows an administrator everything: all apps' items, health, the audit link, everybody's tokens", async () => {
    const r = await get("/overview", "root");
    expect(r.status).toBe(200);
    const html = await r.text();
    expect(html).toContain("bob-crm goes offline");
    expect(html).toContain("The exemption for alice-blog ends");
    expect(html).toContain("1 access token runs out within 7 days"); // bob's, seen by the admin
    expect(html).toContain("nobody-app has no owner");
    expect(html).toContain(">Health<");
    expect(html).toContain("1 issue");
    expect(html).toContain("Traefik");
    expect(html).toContain('href="/audit"');
    expect(statValue(html, "deploys")).toBe(3);
    expect(statValue(html, "hits")).toBe(97);
    expect(hitsCard(html)).toMatch(/bob-crm[\s\S]*alice-shop/);
  });

  it("shows an owner only their own apps, tokens and numbers, and no server information", async () => {
    const r = await get("/overview", "alice");
    expect(r.status).toBe(200);
    const html = await r.text();
    expect(html).toContain("The exemption for alice-blog ends");
    for (const secret of ["bob-crm", "bob-ci", "CVE-2026-7777", "nobody-app", "Traefik", "/audit", ">Health<", "Recent activity"]) {
      expect(html).not.toContain(secret);
    }
    expect(html).not.toContain("access token"); // alice's own token is 60 days away
    expect(html).toContain(">Expiring<");
    expect(statValue(html, "deploys")).toBe(1);
    expect(statValue(html, "hits")).toBe(7);
    expect(statValue(html, "kev")).toBe(0);
  });

  it("tells bob about bob's own token and KEV term, and nothing of alice's", async () => {
    const html = await (await get("/overview", "bob")).text();
    expect(html).toContain("bob-crm goes offline");
    expect(html).toContain("1 access token of yours runs out within 7 days");
    expect(html).toContain('href="/account"');
    expect(html).not.toMatch(/\balice/);
    expect(statValue(html, "deploys")).toBe(2);
    expect(statValue(html, "kev")).toBe(1);
  });

  it("is calm for an owner without apps, with the next rebuild and no server information", async () => {
    const r = await get("/overview", "carol");
    expect(r.status).toBe(200);
    const html = await r.text();
    expect(html).toContain("Everything is fine");
    expect(html).toContain("Next rebuild of apps with issues:");
    expect(html).not.toMatch(/Next rebuild of all apps/i);
    expect(html).not.toContain("Traefik");
    expect(html).not.toMatch(/\balice/);
    expect(html).not.toMatch(/\bbob\b/);
    expect(html).not.toContain("nobody-app");
  });

  it("keeps the same inbox counts as the headline", async () => {
    const html = await (await get("/overview", "root")).text();
    const headline = html.match(/<h2>(\d+) things? needs? attention<\/h2>/);
    expect(headline).not.toBeNull();
    const rows = (html.match(/<li class="ov-item/g) ?? []).length;
    const info = (html.match(/data-key="ownerless"/g) ?? []).length;
    expect(Number(headline![1])).toBe(rows - info - (html.match(/data-key="(major|updated|resolved|exempt-ended):/g) ?? []).length);
  });

  it("picks the period from the query and falls back to 7 days", async () => {
    const day = await (await get("/overview?period=24h", "root")).text();
    expect(day).toContain('<a href="/overview?period=24h" aria-current="true">24 h</a>');
    expect(day).toContain("Last 24 hours");
    const junk = await (await get("/overview?period=forever", "root")).text();
    expect(junk).toContain('<a href="/overview?period=7d" aria-current="true">7 d</a>');
  });

  it("puts Overview at the top of the sidebar for everybody, and in the palette", async () => {
    for (const who of ["root", "alice", "carol"]) {
      const html = await (await get("/overview", who)).text();
      const nav = html.match(/<nav class="side-nav"[\s\S]*?<\/nav>/)![0];
      expect(nav.indexOf('href="/overview"')).toBeGreaterThan(-1);
      expect(nav.indexOf('href="/overview"')).toBeLessThan(nav.indexOf('href="/"'));
      expect(html).toContain('"t":"Overview","h":"/overview"');
    }
  });

  it("is not the start page", async () => {
    const html = await (await get("/", "root")).text();
    expect(html).toContain("<h1 style=\"margin:0\">Apps</h1>");
  });
});
