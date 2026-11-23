/**
 * S13 through the real app (CSRF and session middleware included): an app
 * belongs to a user id, not to a name. A new account that reuses the name of
 * a deleted or renamed user gets nothing; an admin sees the app as
 * ownerless; the real owner keeps working. No Docker needed: every denial
 * happens before any heavy work, and the one allowed rescan path is only
 * probed up to its guard.
 */
import { beforeAll, describe, expect, it } from "vitest";

import { app } from "../app.js";
import { db, migrate } from "../db/index.js";
import { createApp, getApp, updateApp } from "../db/apps.js";
import { createSession } from "../db/sessions.js";
import { createUser, getUserByUsername } from "../db/users.js";

const CSRF = "test-csrf-token";
const tok: Record<string, string> = {};
const ids: Record<string, string> = {};
let aliceId = "";
let bobId = "";

beforeAll(async () => {
  migrate();
  const root = await createUser("root", "pw-root-123456", "admin");
  const alice = await createUser("alice", "pw-alice-123456", "member");
  const bob = await createUser("bob", "pw-bob-123456", "member");
  aliceId = alice.id;
  bobId = bob.id;
  tok.root = createSession(root.id).token;
  tok.alice = createSession(alice.id).token;
  tok.bob = createSession(bob.id).token;
  for (const [key, owner, name] of [
    ["alice1", alice, "Alice shop"],
    ["alice2", alice, "Alice blog"],
    ["bob1", bob, "Bob wiki"],
  ] as const) {
    const a = createApp(owner);
    updateApp(a.id, { name, runtime: "node", status: "running", image_tag: `runway/${key}:1` } as never);
    ids[key] = a.id;
  }
});

const get = (path: string, who: string | null) =>
  app.request(path, { headers: who ? { cookie: `runway_session=${tok[who]}` } : {} });

function post(path: string, who: string) {
  return app.request(path, {
    method: "POST",
    headers: {
      cookie: `runway_session=${tok[who]}; runway_csrf=${CSRF}`,
      "content-type": "application/x-www-form-urlencoded",
    },
    body: `_csrf=${CSRF}`,
  });
}

const loc = (r: Response) => r.headers.get("location") ?? "";

describe("the owner is the account, not the name", () => {
  it("the real owner reaches their app and sees it listed", async () => {
    const page = await get(`/apps/${ids.alice1}`, "alice");
    expect(page.status).toBe(200);
    const home = await (await get("/", "alice")).text();
    expect(home).toContain("Alice shop");
    expect(home).not.toContain("Bob wiki");
  });

  it("another member does not reach it", async () => {
    const res = await get(`/apps/${ids.alice1}`, "bob");
    expect(res.status).toBe(302);
    expect(loc(res)).toContain("forbidden");
    expect(loc(await post(`/apps/${ids.alice1}/rescan`, "bob"))).toContain("forbidden");
    expect(loc(await post(`/apps/${ids.alice1}/rebuild`, "bob"))).toContain("forbidden");
  });

  it("deleting a user keeps their apps and leaves them without an owner, with an audit note", async () => {
    const res = await post(`/users/${aliceId}/delete`, "root");
    expect(res.status).toBe(302);
    expect(getUserByUsername("alice")).toBeUndefined();
    expect(getApp(ids.alice1)).toBeDefined();
    expect(getApp(ids.alice1)!.owner_user_id).toBeNull();
    expect(getApp(ids.alice2)!.owner_user_id).toBeNull();
    expect(getApp(ids.bob1)!.owner_user_id).toBe(bobId);
    const row = db
      .prepare(`SELECT detail FROM audit_log WHERE action = 'user_deleted' ORDER BY id DESC LIMIT 1`)
      .get() as { detail: string };
    expect(row.detail).toContain("2 app(s) now without an owner");
  });

  it("a new account that takes the deleted name inherits nothing", async () => {
    const newAlice = await createUser("alice", "pw-new-alice-123", "member");
    tok.newAlice = createSession(newAlice.id).token;

    for (const key of ["alice1", "alice2"]) {
      const page = await get(`/apps/${ids[key]}`, "newAlice");
      expect(page.status).toBe(302);
      expect(loc(page)).toContain("forbidden");
      expect(loc(await post(`/apps/${ids[key]}/rescan`, "newAlice"))).toContain("forbidden");
      expect(loc(await post(`/apps/${ids[key]}/rebuild`, "newAlice"))).toContain("forbidden");
    }
    const home = await (await get("/", "newAlice")).text();
    expect(home).not.toContain("Alice shop");
    expect(home).not.toContain("Alice blog");
    // Nor do other members' apps appear.
    expect(home).not.toContain("Bob wiki");
  });

  it("an admin still manages the ownerless app and sees it is ownerless", async () => {
    const page = await get(`/apps/${ids.alice1}`, "root");
    expect(page.status).toBe(200);
    expect(await page.text()).toContain("No owner (admin only)");
    const home = await (await get("/", "root")).text();
    expect(home).toContain("No owner (admin only)");
  });

  it("a renamed account keeps its apps", async () => {
    db.prepare(`UPDATE users SET username = 'bobby' WHERE id = ?`).run(bobId);
    const page = await get(`/apps/${ids.bob1}`, "bob");
    expect(page.status).toBe(200);
    const home = await (await get("/", "root")).text();
    expect(home).toContain("bobby");
  });

  it("someone who takes a renamed account's old name gets nothing of it", async () => {
    const newBob = await createUser("bob", "pw-new-bob-123456", "member");
    tok.newBob = createSession(newBob.id).token;
    expect(loc(await get(`/apps/${ids.bob1}`, "newBob"))).toContain("forbidden");
  });

  it("the Users page lists apps by account, not by name", async () => {
    const html = await (await get("/users", "root")).text();
    // The new "alice" and the new "bob" own nothing; "bobby" still owns Bob wiki.
    const bobbyCard = html.split("bobby")[1] ?? "";
    expect(bobbyCard).toContain("Bob wiki");
  });
});
