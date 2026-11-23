/**
 * Assigning an owner to an app (follow-up to S13): POST /apps/:id/owner is
 * admin-only, CSRF enforced, audited, works on the user id, and moves what
 * the new and the old owner can see. Drives the real app against an
 * in-memory database.
 */
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { app } from "../app.js";
import { db, migrate } from "../db/index.js";
import { appsVisibleTo, createApp, getApp, setAppOwner } from "../db/apps.js";
import { createSession } from "../db/sessions.js";
import { createUser } from "../db/users.js";
import { renderOwnerCard } from "../ui/owner.js";

const CSRF = "test-csrf-token";
let sessions: Record<string, string> = {};
let ids: Record<string, string> = {};
let target = "";

beforeAll(async () => {
  migrate();
  const admin = await createUser("root", "pw-root-123456", "admin");
  const alice = await createUser("alice", "pw-alice-123456", "member");
  const bob = await createUser("bob", "pw-bob-123456", "member");
  sessions = {
    root: createSession(admin.id).token,
    alice: createSession(alice.id).token,
    bob: createSession(bob.id).token,
  };
  ids = { root: admin.id, alice: alice.id, bob: bob.id };
  target = createApp("nobody").id;
  db.prepare(`UPDATE apps SET owner_user_id = NULL, name = 'Orphan shop' WHERE id = ?`).run(target);
});

afterEach(() => {
  db.prepare(`UPDATE apps SET owner_user_id = NULL WHERE id = ?`).run(target);
});

function post(path: string, who: string | null, fields: Record<string, string>, csrf = true) {
  const cookie = [who ? `runway_session=${sessions[who]}` : "", csrf ? `runway_csrf=${CSRF}` : ""]
    .filter(Boolean)
    .join("; ");
  const body = new URLSearchParams(fields);
  if (csrf) body.set("_csrf", CSRF);
  return app.request(path, {
    method: "POST",
    headers: { cookie, "content-type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });
}
const get = (path: string, who: string) =>
  app.request(path, { headers: { cookie: `runway_session=${sessions[who]}` } });
const loc = (r: Response) => r.headers.get("location");
const owner = () => getApp(target)!.owner_user_id;
const audits = () =>
  db.prepare(`SELECT detail, target_user_id FROM audit_log WHERE action = 'app_owner_assigned' ORDER BY id`).all() as Array<{
    detail: string;
    target_user_id: string | null;
  }>;

describe("POST /apps/:id/owner", () => {
  it("lets an admin give an ownerless app to a user, and audits it", async () => {
    const before = audits().length;
    const r = await post(`/apps/${target}/owner`, "root", { owner: ids.alice });
    expect(loc(r)).toBe(`/apps/${target}?saved=1#owner`);
    expect(owner()).toBe(ids.alice);
    const rows = audits();
    expect(rows.length).toBe(before + 1);
    expect(rows[rows.length - 1]!.detail).toBe(`${target}: no owner -> alice`);
    expect(rows[rows.length - 1]!.target_user_id).toBe(ids.alice);
  });

  it("the new owner now sees and can open the app; others still cannot", async () => {
    await post(`/apps/${target}/owner`, "root", { owner: ids.alice });
    expect(appsVisibleTo(ids.alice!, false).some((a) => a.id === target)).toBe(true);
    expect(appsVisibleTo(ids.bob!, false).some((a) => a.id === target)).toBe(false);
    expect((await get(`/apps/${target}`, "alice")).status).toBe(200);
    expect(loc(await get(`/apps/${target}`, "bob"))).toBe("/?forbidden=1");
  });

  it("re-assigning moves the rights: the previous owner loses the app at once", async () => {
    await post(`/apps/${target}/owner`, "root", { owner: ids.alice });
    const r = await post(`/apps/${target}/owner`, "root", { owner: ids.bob });
    expect(loc(r)).toBe(`/apps/${target}?saved=1#owner`);
    expect(owner()).toBe(ids.bob);
    expect(loc(await get(`/apps/${target}`, "alice"))).toBe("/?forbidden=1");
    expect((await get(`/apps/${target}`, "bob")).status).toBe(200);
    const last = audits().pop()!;
    expect(last.detail).toBe(`${target}: alice -> bob`);
  });

  it("an empty value makes the app ownerless again (admin-only)", async () => {
    await post(`/apps/${target}/owner`, "root", { owner: ids.alice });
    const r = await post(`/apps/${target}/owner`, "root", { owner: "" });
    expect(loc(r)).toBe(`/apps/${target}?saved=1#owner`);
    expect(owner()).toBeNull();
    expect(loc(await get(`/apps/${target}`, "alice"))).toBe("/?forbidden=1");
  });

  it("an unknown user id changes nothing and writes no audit line", async () => {
    await post(`/apps/${target}/owner`, "root", { owner: ids.alice });
    const before = audits().length;
    const r = await post(`/apps/${target}/owner`, "root", { owner: "no-such-user" });
    expect(loc(r)).toBe(`/apps/${target}#owner`);
    expect(owner()).toBe(ids.alice);
    expect(audits().length).toBe(before);
  });

  it("a member (even the current owner) cannot change the owner", async () => {
    await post(`/apps/${target}/owner`, "root", { owner: ids.alice });
    const before = audits().length;
    const r = await post(`/apps/${target}/owner`, "alice", { owner: ids.bob });
    expect(loc(r)).toBe("/");
    expect(owner()).toBe(ids.alice);
    const r2 = await post(`/apps/${target}/owner`, "bob", { owner: ids.bob });
    expect(loc(r2)).toBe("/?forbidden=1");
    expect(owner()).toBe(ids.alice);
    expect(audits().length).toBe(before);
  });

  it("rejects a request without the CSRF token", async () => {
    const r = await post(`/apps/${target}/owner`, "root", { owner: ids.alice }, false);
    expect(r.status).toBe(403);
    expect(owner()).toBeNull();
  });

  it("sends an anonymous visitor away and changes nothing", async () => {
    const r = await post(`/apps/${target}/owner`, null, { owner: ids.alice });
    expect([301, 302, 303, 401, 403]).toContain(r.status);
    expect(owner()).toBeNull();
  });

  it("does nothing for an unknown app", async () => {
    const r = await post(`/apps/nope/owner`, "root", { owner: ids.alice });
    expect(loc(r)).toBe("/");
  });
});

describe("Config tab card", () => {
  it("an admin sees the Owner card, with the current owner selected", async () => {
    await post(`/apps/${target}/owner`, "root", { owner: ids.alice });
    const html = await (await get(`/apps/${target}`, "root")).text();
    expect(html).toContain('id="owner"');
    expect(html).toContain(`action="/apps/${target}/owner"`);
    expect(html).toMatch(new RegExp(`<option value="${ids.alice}" selected>alice</option>`));
  });

  it("the owner does not get the form", async () => {
    await post(`/apps/${target}/owner`, "root", { owner: ids.alice });
    const html = await (await get(`/apps/${target}`, "alice")).text();
    expect(html).not.toContain(`action="/apps/${target}/owner"`);
  });

  it("an ownerless app says so in plain words", () => {
    const html = renderOwnerCard({ id: "x", owner_user_id: null }, null, [{ id: "u1", username: "alice", role: "member" }]);
    expect(html).toContain("Only administrators can see and manage this app");
    expect(html).toContain('<option value="" selected>No owner (admin only)</option>');
  });

  it("escapes names", () => {
    const html = renderOwnerCard({ id: "x", owner_user_id: "u1" }, '<b>"x"', [
      { id: "u1", username: '<img onerror=1>', role: "admin" },
    ]);
    expect(html).not.toContain("<img onerror");
    expect(html).not.toContain("<b>\"x\"");
  });
});

describe("setAppOwner", () => {
  it("refuses a user that does not exist and an app that does not exist", () => {
    expect(setAppOwner(target, "ghost")).toEqual({ ok: false });
    expect(setAppOwner("nope", ids.alice!)).toEqual({ ok: false });
    expect(owner()).toBeNull();
  });
  it("returns the previous owner", () => {
    setAppOwner(target, ids.alice!);
    expect(setAppOwner(target, ids.bob!)).toEqual({ ok: true, previous: ids.alice });
  });
});
