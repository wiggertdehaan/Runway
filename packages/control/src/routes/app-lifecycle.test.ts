/**
 * Lifecycle at the routes: rights, confirmation, the trash and its filter, the
 * API and the app key of a trashed app. Docker, the gateway and the health
 * wait are replaced; the app, the database and the rights code are real.
 */
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const fake = vi.hoisted(() => ({ image: null as string | null }));
vi.mock("../deploy/docker.js", async (orig) => {
  const real = await orig<typeof import("../deploy/docker.js")>();
  return {
    ...real,
    containerImageTag: vi.fn(async () => fake.image),
    startContainerByName: vi.fn(async () => {}),
    restartContainerByName: vi.fn(async () => {}),
    stopContainerByName: vi.fn(async () => {}),
    removeContainerByName: vi.fn(async () => {}),
    runContainer: vi.fn(async () => ({ containerId: "c" })),
    getContainerStatus: vi.fn(async () => ({ exists: false })),
  };
});
vi.mock("../deploy/gateway.js", async (orig) => {
  const real = await orig<typeof import("../deploy/gateway.js")>();
  return { ...real, writeAppRoute: vi.fn(async () => {}), writeMaintenanceRoute: vi.fn(async () => {}), deleteAppRoute: vi.fn(async () => {}) };
});
vi.mock("../deploy/health.js", () => ({ waitForHealthy: vi.fn(async () => ({ healthy: true, reason: "ok" })), judgeHealth: vi.fn() }));

import { app } from "../app.js";
import { db, migrate } from "../db/index.js";
import { createApp, getApp, updateApp } from "../db/apps.js";
import { createSession } from "../db/sessions.js";
import { createUserToken } from "../db/user-tokens.js";
import { createUser } from "../db/users.js";
import { setSetting } from "../db/settings.js";
import { resetTokenLimits } from "../middleware/token-limit.js";

const CSRF = "test-csrf-token";
let sessions: Record<string, string> = {};
let ids: Record<string, string> = {};
let mine = { id: "", key: "" };

beforeAll(async () => {
  migrate();
  setSetting("base_domain", "example.com");
  const admin = await createUser("root", "pw-root-123456", "admin");
  const alice = await createUser("alice", "pw-alice-123456", "member");
  const bob = await createUser("bob", "pw-bob-123456", "member");
  sessions = { root: createSession(admin.id).token, alice: createSession(alice.id).token, bob: createSession(bob.id).token };
  ids = { root: admin.id, alice: alice.id, bob: bob.id };
});

beforeEach(() => {
  resetTokenLimits();
  fake.image = "img:v1";
  db.exec("DELETE FROM apps");
  db.exec("DELETE FROM audit_log");
  const a = createApp({ id: ids.alice!, username: "alice" });
  updateApp(a.id, { name: "Rosa Cockpit", runtime: "node", port: 3000, domain: "rosa-cockpit.example.com", image_tag: "img:v1", status: "running" } as never);
  mine = { id: a.id, key: a.api_key };
});

function post(path: string, who: string, fields: Record<string, string> = {}) {
  const body = new URLSearchParams({ ...fields, _csrf: CSRF });
  return app.request(path, {
    method: "POST",
    headers: { cookie: `runway_session=${sessions[who]}; runway_csrf=${CSRF}`, "content-type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });
}
const page = (path: string, who: string) => app.request(path, { headers: { cookie: `runway_session=${sessions[who]}` } });
const loc = (r: Response) => r.headers.get("location") ?? "";
const audits = () => (db.prepare(`SELECT action, username FROM audit_log ORDER BY id`).all() as Array<{ action: string; username: string }>).map((r) => `${r.action}:${r.username}`);
const status = () => getApp(mine.id)!.status;

describe("dashboard: stop / start / restart", () => {
  it("the owner stops and starts; both are audited", async () => {
    const s = await post(`/apps/${mine.id}/stop`, "alice");
    expect(loc(s)).toBe(`/apps/${mine.id}?lc=stopped`);
    expect(status()).toBe("stopped");
    const st = await post(`/apps/${mine.id}/start`, "alice");
    expect(loc(st)).toContain("lc=started");
    expect(status()).toBe("running");
    const rs = await post(`/apps/${mine.id}/restart`, "alice");
    expect(loc(rs)).toContain("lc=restarted");
    expect(audits()).toEqual(["app_stopped:alice", "app_started:alice", "app_restarted:alice"]);
  });
  it("an admin may too", async () => {
    await post(`/apps/${mine.id}/stop`, "root");
    expect(status()).toBe("stopped");
  });
  it("somebody else is turned away and nothing changes (every action)", async () => {
    for (const action of ["stop", "start", "restart", "delete", "restore", "purge"]) {
      const r = await post(`/apps/${mine.id}/${action}`, "bob", { confirm: "Rosa Cockpit" });
      expect(loc(r), action).toBe("/?forbidden=1");
    }
    expect(status()).toBe("running");
    expect(getApp(mine.id)!.deleted_at).toBeNull();
    expect(audits()).toEqual([]);
  });
  it("without a session or a CSRF token it is refused", async () => {
    const noCsrf = await app.request(`/apps/${mine.id}/stop`, { method: "POST", headers: { cookie: `runway_session=${sessions.alice}`, "content-type": "application/x-www-form-urlencoded" }, body: "" });
    expect(noCsrf.status).toBe(403);
    expect(status()).toBe("running");
    const anon = await app.request(`/apps/${mine.id}/stop`, { method: "POST" });
    expect([302, 401, 403]).toContain(anon.status);
    expect(status()).toBe("running");
  });
  it("a refused action says why on the app page (fixed text, nothing reflected)", async () => {
    updateApp(mine.id, { status: "building" } as never);
    const r = await post(`/apps/${mine.id}/stop`, "alice");
    expect(loc(r)).toContain("lc=busy");
    const html = await (await page(`/apps/${mine.id}?lc=busy`, "alice")).text();
    expect(html).toContain("still running on this app");
    const evil = await (await page(`/apps/${mine.id}?lc=<script>alert(1)</script>`, "alice")).text();
    expect(evil).not.toContain("<script>alert(1)</script>");
  });
  it("a quarantined app cannot be started and the page explains", async () => {
    updateApp(mine.id, { status: "quarantined" } as never);
    const r = await post(`/apps/${mine.id}/start`, "alice");
    expect(loc(r)).toContain("lc=quarantined");
    expect(status()).toBe("quarantined");
  });
  it("the menu offers Stop for a running app and Start for a stopped one; a stopped app shows its banner", async () => {
    let html = await (await page("/", "alice")).text();
    expect(html).toContain(`action="/apps/${mine.id}/stop"`);
    expect(html).not.toContain(`action="/apps/${mine.id}/start"`);
    await post(`/apps/${mine.id}/stop`, "alice");
    html = await (await page("/", "alice")).text();
    expect(html).toContain(`action="/apps/${mine.id}/start"`);
    const appPage = await (await page(`/apps/${mine.id}`, "alice")).text();
    expect(appPage).toContain("temporarily offline");
    expect(appPage).toContain('class="card stopped-banner"');
  });
});

describe("dashboard: delete = trash", () => {
  it("needs the exact name, server side", async () => {
    for (const bad of ["", "rosa cockpit", "Rosa", "Rosa Cockpit x"]) {
      const r = await post(`/apps/${mine.id}/delete`, "alice", { confirm: bad });
      expect(r.status, bad).toBe(400);
    }
    const none = await post(`/apps/${mine.id}/delete`, "alice");
    expect(none.status).toBe(400);
    expect(getApp(mine.id)!.deleted_at).toBeNull();
  });
  it("moves to the trash: gone from the normal list, in the Deleted filter for the owner and admins only", async () => {
    const r = await post(`/apps/${mine.id}/delete`, "alice", { confirm: "Rosa Cockpit" });
    expect(loc(r)).toBe("/?trashed=1");
    expect(getApp(mine.id)!.deleted_at).toBeTruthy();
    expect(audits()).toContain("app_deleted:alice");
    const owner = await (await page("/", "alice")).text();
    expect(owner).toContain('data-chip="deleted"');
    expect(owner).toContain('data-status="deleted"');
    expect(owner).toContain("days left");
    expect(owner).toContain(`action="/apps/${mine.id}/restore"`);
    expect(owner).not.toContain(`data-del-name="Rosa Cockpit" data-del-mode="purge"`);
    expect(owner).not.toContain(`/apps/${mine.id}/stop`);
    const other = await (await page("/", "bob")).text();
    expect(other).not.toContain("Rosa Cockpit");
    expect(other).not.toContain('data-chip="deleted"');
    const admin = await (await page("/", "root")).text();
    expect(admin).toContain(`data-del-action="/apps/${mine.id}/purge"`);
  });
  it("the confirmation dialog is on the list page and on the app page", async () => {
    expect(await (await page("/", "alice")).text()).toContain('id="del-dlg"');
    expect(await (await page(`/apps/${mine.id}`, "alice")).text()).toContain('id="del-dlg"');
  });
  it("a trashed app has no app page and no other action; restore and purge are the only ways in", async () => {
    await post(`/apps/${mine.id}/delete`, "alice", { confirm: "Rosa Cockpit" });
    expect(loc(await page(`/apps/${mine.id}`, "alice"))).toBe("/");
    for (const action of ["start", "stop", "restart", "env", "description", "healthcheck"]) {
      expect(loc(await post(`/apps/${mine.id}/${action}`, "alice")), action).toBe("/");
    }
    expect(getApp(mine.id)!.status).toBe("stopped");
  });
  it("the owner restores it: a stopped app again, listed normally", async () => {
    await post(`/apps/${mine.id}/delete`, "alice", { confirm: "Rosa Cockpit" });
    const r = await post(`/apps/${mine.id}/restore`, "alice");
    expect(loc(r)).toBe(`/apps/${mine.id}`);
    expect(getApp(mine.id)!.deleted_at).toBeNull();
    expect(status()).toBe("stopped");
    expect(audits()).toContain("app_restored:alice");
    expect(await (await page("/", "alice")).text()).not.toContain('data-chip="deleted"');
  });
  it("Delete now: admins only, name typed again, then everything is gone", async () => {
    await post(`/apps/${mine.id}/delete`, "alice", { confirm: "Rosa Cockpit" });
    expect(loc(await post(`/apps/${mine.id}/purge`, "alice", { confirm: "Rosa Cockpit" }))).toBe("/?forbidden=1");
    expect(getApp(mine.id)).toBeTruthy();
    expect((await post(`/apps/${mine.id}/purge`, "root", { confirm: "wrong" })).status).toBe(400);
    expect(getApp(mine.id)).toBeTruthy();
    await post(`/apps/${mine.id}/purge`, "root", { confirm: "Rosa Cockpit" });
    expect(getApp(mine.id)).toBeUndefined();
    expect(audits()).toContain("app_purged:root");
  });
  it("Delete now on an app that is not in the trash does nothing", async () => {
    await post(`/apps/${mine.id}/purge`, "root", { confirm: "Rosa Cockpit" });
    expect(getApp(mine.id)).toBeTruthy();
  });
  it("a name is escaped in the trash row and in the dialog attributes", async () => {
    const n = `<img src=x onerror=alert(1)>"`;
    updateApp(mine.id, { name: n } as never);
    await post(`/apps/${mine.id}/delete`, "alice", { confirm: n });
    const html = await (await page("/", "root")).text();
    expect(html).not.toContain("<img src=x");
    expect(html).toContain("&lt;img src=x onerror=alert(1)&gt;");
  });
  it("while it is in the trash nobody can claim its name or address", async () => {
    await post(`/apps/${mine.id}/delete`, "alice", { confirm: "Rosa Cockpit" });
    const b = createApp({ id: ids.bob!, username: "bob" });
    const r = await app.request("/api/v1/app/configure", {
      method: "POST",
      headers: { authorization: `Bearer ${b.api_key}`, "content-type": "application/json" },
      body: JSON.stringify({ name: "Rosa Cockpit", runtime: "node" }),
    });
    expect(r.status).toBe(409);
  });
});

describe("the gateway page", () => {
  const maint = (host: string) => app.request(`http://${host}/maintenance`, { headers: { host } });
  it("says 'switched off' for a stopped app and keeps the security text for others", async () => {
    await post(`/apps/${mine.id}/stop`, "alice");
    expect(await (await maint("rosa-cockpit.example.com")).text()).toContain("switched off for now");
    expect(await (await maint("unknown.example.com")).text()).toContain("security maintenance");
    updateApp(mine.id, { status: "quarantined" } as never);
    expect(await (await maint("rosa-cockpit.example.com")).text()).toContain("security maintenance");
    const r = await maint("rosa-cockpit.example.com");
    expect(r.status).toBe(503);
  });
});

describe("API", () => {
  const call = (method: string, path: string, key: string, body?: unknown) =>
    app.request(`/api/v1${path}`, {
      method,
      headers: { authorization: `Bearer ${key}`, ...(body !== undefined ? { "content-type": "application/json" } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  it("stop / start / restart with the app's key", async () => {
    const s = await call("POST", "/app/stop", mine.key);
    expect(s.status).toBe(200);
    expect(await s.json()).toMatchObject({ status: "stopped", changed: true });
    expect((await (await call("POST", "/app/stop", mine.key)).json()).changed).toBe(false);
    const st = await call("POST", "/app/start", mine.key);
    expect(await st.json()).toMatchObject({ status: "running", changed: true });
    expect((await call("POST", "/app/restart", mine.key)).status).toBe(200);
  });
  it("refusals carry a code and a fitting status", async () => {
    updateApp(mine.id, { status: "building" } as never);
    const busy = await call("POST", "/app/stop", mine.key);
    expect(busy.status).toBe(409);
    expect(await busy.json()).toMatchObject({ code: "busy" });
    updateApp(mine.id, { status: "quarantined" } as never);
    expect((await call("POST", "/app/start", mine.key)).status).toBe(409);
  });
  it("DELETE /app needs `confirm` = the exact name and only trashes", async () => {
    expect((await call("DELETE", "/app", mine.key, {})).status).toBe(400);
    expect((await call("DELETE", "/app", mine.key, { confirm: "rosa cockpit" })).status).toBe(400);
    expect(getApp(mine.id)!.deleted_at).toBeNull();
    const r = await call("DELETE", "/app", mine.key, { confirm: "Rosa Cockpit" });
    expect(r.status).toBe(200);
    expect(await r.json()).toMatchObject({ status: "in_trash" });
    expect(getApp(mine.id)!.deleted_at).toBeTruthy();
    expect(getApp(mine.id)).toBeTruthy();
  });
  it("the key of a trashed app is answered with 410 and the reason, not as a wrong key", async () => {
    await call("DELETE", "/app", mine.key, { confirm: "Rosa Cockpit" });
    const r = await call("GET", "/app", mine.key);
    expect(r.status).toBe(410);
    expect((await r.json()).error).toContain("trash");
    expect((await call("POST", "/app/start", mine.key)).status).toBe(410);
  });
  it("a user token cannot reach a trashed app, nor list it", async () => {
    const { token } = createUserToken(ids.alice!, "t", "deploy");
    await post(`/apps/${mine.id}/delete`, "alice", { confirm: "Rosa Cockpit" });
    const direct = await app.request("/api/v1/app", { headers: { authorization: `Bearer ${token}`, "x-runway-app": mine.id } });
    expect(direct.status).toBe(404);
    const list = await (await app.request("/api/v1/apps", { headers: { authorization: `Bearer ${token}` } })).json();
    expect(list.apps).toEqual([]);
  });
  it("another app's key cannot stop this app, and a read-only token cannot stop anything", async () => {
    const b = createApp({ id: ids.bob!, username: "bob" });
    updateApp(b.id, { name: "Bobs", runtime: "node", port: 3000, image_tag: "i:1", status: "running" } as never);
    await call("POST", "/app/stop", b.api_key);
    expect(status()).toBe("running");
    const { token } = createUserToken(ids.alice!, "ro", "read");
    const r = await app.request("/api/v1/app/stop", { method: "POST", headers: { authorization: `Bearer ${token}`, "x-runway-app": mine.id } });
    expect(r.status).toBe(403);
    expect(status()).toBe("running");
  });
  it("lifecycle calls are audited by the API audit middleware", async () => {
    await call("POST", "/app/stop", mine.key);
    const rows = db.prepare(`SELECT action FROM audit_log`).all() as Array<{ action: string }>;
    expect(rows.some((r) => /stop/.test(r.action))).toBe(true);
  });
});

describe("events", () => {
  it("lifecycle events are in the event feed for the app", async () => {
    await post(`/apps/${mine.id}/stop`, "alice");
    await post(`/apps/${mine.id}/start`, "alice");
    const r = await app.request("/api/v1/events", { headers: { authorization: `Bearer ${mine.key}` } });
    const body = await r.json();
    const codes = body.events.map((e: { code: string }) => e.code);
    expect(codes).toEqual(expect.arrayContaining(["app_stopped", "app_started"]));
    expect(body.events.find((e: { code: string }) => e.code === "app_stopped").type).toBe("lifecycle");
  });
});
