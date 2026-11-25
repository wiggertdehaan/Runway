/**
 * The app description: set through the API (PUT /app/description) and the
 * dashboard (POST /apps/:id/description, owner or admin only), shown in the
 * config, the app list, the app page and the apps overview, always escaped,
 * length-bounded on the server. Drives the real app against an in-memory DB.
 */
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { app } from "../app.js";
import { db, migrate } from "../db/index.js";
import { createApp, getApp, setDescriptionIfEmpty, updateApp } from "../db/apps.js";
import { createSession } from "../db/sessions.js";
import { createUser } from "../db/users.js";
import { createUserToken } from "../db/user-tokens.js";
import { setSetting } from "../db/settings.js";
import { resetTokenLimits } from "../middleware/token-limit.js";
import { MAX_DESCRIPTION } from "../util/description.js";

const CSRF = "test-csrf-token";
let sessions: Record<string, string> = {};
let ids: Record<string, string> = {};
let mine = { id: "", key: "" };
let theirs = { id: "", key: "" };

beforeAll(async () => {
  migrate();
  setSetting("base_domain", "example.com");
  const admin = await createUser("root", "pw-root-123456", "admin");
  const alice = await createUser("alice", "pw-alice-123456", "member");
  const bob = await createUser("bob", "pw-bob-123456", "member");
  sessions = { root: createSession(admin.id).token, alice: createSession(alice.id).token, bob: createSession(bob.id).token };
  ids = { root: admin.id, alice: alice.id, bob: bob.id };
  const a = createApp({ id: alice.id, username: "alice" });
  updateApp(a.id, { name: "Rosa Cockpit", runtime: "node" } as never);
  mine = { id: a.id, key: a.api_key };
  const b = createApp({ id: bob.id, username: "bob" });
  updateApp(b.id, { name: "Itemclearing", runtime: "node" } as never);
  theirs = { id: b.id, key: b.api_key };
});

beforeEach(() => {
  resetTokenLimits();
  db.prepare(`UPDATE apps SET description = NULL`).run();
});

function put(key: string, body: unknown) {
  return app.request("/api/v1/app/description", {
    method: "PUT",
    headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}
const getConfig = (key: string) => app.request("/api/v1/app", { headers: { authorization: `Bearer ${key}` } });

function post(path: string, who: string, fields: Record<string, string>) {
  const body = new URLSearchParams({ ...fields, _csrf: CSRF });
  return app.request(path, {
    method: "POST",
    headers: { cookie: `runway_session=${sessions[who]}; runway_csrf=${CSRF}`, "content-type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });
}
const page = (path: string, who: string) => app.request(path, { headers: { cookie: `runway_session=${sessions[who]}` } });

describe("migration", () => {
  it("adds the column once and an app starts without a description", () => {
    migrate();
    migrate();
    const cols = (db.prepare(`PRAGMA table_info(apps)`).all() as Array<{ name: string }>).filter((c) => c.name === "description");
    expect(cols).toHaveLength(1);
    expect(getApp(mine.id)!.description).toBeNull();
  });
});

describe("API", () => {
  it("sets, shows in /app and clears", async () => {
    const r = await put(mine.key, { description: "  Dashboard for the field team.\nOpen jobs per region. " });
    expect(r.status).toBe(200);
    expect((await r.json()).description).toBe("Dashboard for the field team. Open jobs per region.");
    expect((await (await getConfig(mine.key)).json()).description).toBe("Dashboard for the field team. Open jobs per region.");
    for (const empty of [null, "", "   "]) {
      await put(mine.key, { description: "x" });
      const c = await put(mine.key, { description: empty });
      expect((await c.json()).description).toBeNull();
    }
  });
  it("config of an app without one says null", async () => {
    expect((await (await getConfig(mine.key)).json()).description).toBeNull();
  });
  it("takes exactly the limit and refuses one more, server side", async () => {
    expect((await put(mine.key, { description: "a".repeat(MAX_DESCRIPTION) })).status).toBe(200);
    const r = await put(mine.key, { description: "a".repeat(MAX_DESCRIPTION + 1) });
    expect(r.status).toBe(400);
    expect(getApp(mine.id)!.description).toBe("a".repeat(MAX_DESCRIPTION));
  });
  it("refuses a body without the field, a non-string and bad JSON", async () => {
    expect((await put(mine.key, {})).status).toBe(400);
    expect((await put(mine.key, { description: 5 })).status).toBe(400);
    expect((await put(mine.key, "{nope")).status).toBe(400);
  });
  it("only changes its own app", async () => {
    await put(mine.key, { description: "Mine" });
    expect(getApp(theirs.id)!.description).toBeNull();
  });
  it("needs a key", async () => {
    const r = await app.request("/api/v1/app/description", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ description: "x" }),
    });
    expect(r.status).toBe(401);
  });
  it("is in the apps list a user token sees", async () => {
    updateApp(mine.id, { description: "Visible in the list" });
    const { token } = createUserToken(ids.alice!, "t", "read");
    const r = await app.request("/api/v1/apps", { headers: { authorization: `Bearer ${token}` } });
    expect(r.status).toBe(200);
    const body = await r.json();
    expect(body.apps.find((a: { id: string }) => a.id === mine.id).description).toBe("Visible in the list");
  });
});

describe("dashboard form", () => {
  it("the owner can set and clear it", async () => {
    const r = await post(`/apps/${mine.id}/description`, "alice", { description: "Made by the owner." });
    expect(r.status).toBe(302);
    expect(getApp(mine.id)!.description).toBe("Made by the owner.");
    await post(`/apps/${mine.id}/description`, "alice", { description: "" });
    expect(getApp(mine.id)!.description).toBeNull();
  });
  it("an admin can set it on any app", async () => {
    await post(`/apps/${mine.id}/description`, "root", { description: "By an admin." });
    expect(getApp(mine.id)!.description).toBe("By an admin.");
  });
  it("somebody else cannot, and nothing changes", async () => {
    updateApp(mine.id, { description: "Original" });
    const r = await post(`/apps/${mine.id}/description`, "bob", { description: "Hijacked" });
    expect(r.status).not.toBe(200);
    expect(getApp(mine.id)!.description).toBe("Original");
  });
  it("too long is refused with 400 and not stored", async () => {
    const r = await post(`/apps/${mine.id}/description`, "alice", { description: "z".repeat(MAX_DESCRIPTION + 1) });
    expect(r.status).toBe(400);
    expect(getApp(mine.id)!.description).toBeNull();
  });
  it("without a CSRF token it is refused", async () => {
    const r = await app.request(`/apps/${mine.id}/description`, {
      method: "POST",
      headers: { cookie: `runway_session=${sessions.alice}`, "content-type": "application/x-www-form-urlencoded" },
      body: "description=x",
    });
    expect(r.status).toBe(403);
    expect(getApp(mine.id)!.description).toBeNull();
  });
});

describe("display", () => {
  const EVIL = `<img src=x onerror=alert(1)> "quoted" & <script>alert(2)</script>`;
  it("app page shows the text under the name, escaped", async () => {
    updateApp(mine.id, { description: EVIL });
    const html = await (await page(`/apps/${mine.id}`, "alice")).text();
    expect(html).toContain(`<p class="app-desc-text">`);
    expect(html).toContain("&lt;img src=x onerror=alert(1)&gt;");
    expect(html).not.toContain("<img src=x");
    expect(html).not.toContain("<script>alert(2)");
    expect(html.indexOf("<h1>Rosa Cockpit")).toBeLessThan(html.indexOf(`<p class="app-desc-text">`));
  });
  it("app page without a description has no text paragraph, only the add link for the owner", async () => {
    const html = await (await page(`/apps/${mine.id}`, "alice")).text();
    expect(html).not.toContain(`<p class="app-desc-text">`);
    expect(html).toContain("Add a description");
  });
  it("app list shows one line with the full text as tooltip, escaped", async () => {
    updateApp(mine.id, { description: EVIL });
    const html = await (await page("/", "alice")).text();
    expect(html).toMatch(/class="app-desc-line" title="[^"]*&lt;img/);
    expect(html).not.toContain("<img src=x");
    expect(html).not.toContain("<script>alert(2)");
  });
  it("app list without a description shows no placeholder", async () => {
    const html = await (await page("/", "alice")).text();
    expect(html).not.toContain('class="app-desc-line"');
  });
  it("one's description is not in somebody else's list", async () => {
    updateApp(mine.id, { description: "Only for alice and admins" });
    const html = await (await page("/", "bob")).text();
    expect(html).not.toContain("Only for alice and admins");
  });
});

describe("never overwritten by a deploy fill", () => {
  it("setDescriptionIfEmpty writes into an empty field", () => {
    expect(setDescriptionIfEmpty(mine.id, "From README")).toBe(true);
    expect(getApp(mine.id)!.description).toBe("From README");
  });
  it("treats a blank field as empty", () => {
    db.prepare(`UPDATE apps SET description = '  ' WHERE id = ?`).run(mine.id);
    expect(setDescriptionIfEmpty(mine.id, "From README")).toBe(true);
  });
  it("keeps a hand-written description", () => {
    updateApp(mine.id, { description: "Written by hand" });
    expect(setDescriptionIfEmpty(mine.id, "From README")).toBe(false);
    expect(getApp(mine.id)!.description).toBe("Written by hand");
  });
});
