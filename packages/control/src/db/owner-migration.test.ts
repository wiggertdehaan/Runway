/**
 * S13: app ownership by user id. The one-time fill of owner_user_id from the
 * old owner name, what it does with names it cannot tie to an account, and
 * that it never runs a second time (a later account with a reused name must
 * not pick up an app that was left without an owner).
 */
import { DatabaseSync } from "node:sqlite";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { db, migrate } from "./index.js";
import { createApp, getApp, isAppOwner, ownerUsernameOf, updateApp } from "./apps.js";
import { backfillOwnerUserIds, resolveOwner } from "./owner-migration.js";
import { createUser, deleteUser } from "./users.js";

describe("resolveOwner", () => {
  const users = [
    { id: "u1", username: "alice" },
    { id: "u2", username: "bob" },
  ];
  it("links an exact, single match", () => {
    expect(resolveOwner("alice", users)).toEqual({ id: "u1", username: "alice" });
  });
  it("links nothing when no account has that name", () => {
    expect(resolveOwner("carol", users)).toBeNull();
  });
  it("does not guess across case: the old check was a strict comparison", () => {
    expect(resolveOwner("Alice", users)).toBeNull();
  });
  it("links nothing for an empty or missing owner", () => {
    expect(resolveOwner(null, users)).toBeNull();
    expect(resolveOwner("", users)).toBeNull();
  });
  it("links nothing when the name is ambiguous", () => {
    const twice = [...users, { id: "u9", username: "alice" }];
    expect(resolveOwner("alice", twice)).toBeNull();
  });
});

/** A database as it was before this change: apps with created_by, no owner_user_id. */
function legacyDb(): DatabaseSync {
  const d = new DatabaseSync(":memory:");
  d.exec(`
    CREATE TABLE users (id TEXT PRIMARY KEY, username TEXT NOT NULL UNIQUE);
    CREATE TABLE apps (id TEXT PRIMARY KEY, name TEXT, created_by TEXT);
    CREATE TABLE audit_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT, user_id TEXT, username TEXT, action TEXT,
      target_user_id TEXT, target_username TEXT, detail TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    ALTER TABLE apps ADD COLUMN owner_user_id TEXT;
  `);
  return d;
}

describe("backfillOwnerUserIds", () => {
  it("links existing owners, reports the ones it cannot tie to an account", () => {
    const d = legacyDb();
    d.exec(`
      INSERT INTO users (id, username) VALUES ('u-alice', 'alice'), ('u-bob', 'bob');
      INSERT INTO apps (id, name, created_by) VALUES
        ('a1', 'Alice shop', 'alice'),
        ('a2', 'Bob blog', 'bob'),
        ('a3', 'Gone', 'dave'),
        ('a4', 'Old row', NULL);
    `);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const res = backfillOwnerUserIds(d);
    warn.mockRestore();

    expect(res.linked).toBe(2);
    expect(res.withoutOwner).toBe(1);
    expect(res.unlinked).toEqual([{ appId: "a3", appName: "Gone", formerOwner: "dave" }]);

    const owner = (id: string) =>
      (d.prepare(`SELECT owner_user_id AS o FROM apps WHERE id = ?`).get(id) as { o: string | null }).o;
    expect(owner("a1")).toBe("u-alice");
    expect(owner("a2")).toBe("u-bob");
    expect(owner("a3")).toBeNull();
    expect(owner("a4")).toBeNull();

    const audit = d.prepare(`SELECT action, detail FROM audit_log`).all() as Array<{ action: string; detail: string }>;
    expect(audit).toHaveLength(1);
    expect(audit[0]!.action).toBe("app_owner_unlinked");
    expect(audit[0]!.detail).toContain('a3 (Gone) was owned by "dave"');
  });

  it("stays quiet and changes nothing when everything links", () => {
    const d = legacyDb();
    d.exec(`
      INSERT INTO users (id, username) VALUES ('u1', 'alice');
      INSERT INTO apps (id, created_by) VALUES ('a1', 'alice');
    `);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const res = backfillOwnerUserIds(d);
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
    expect(res.unlinked).toEqual([]);
    expect((d.prepare(`SELECT COUNT(*) AS n FROM audit_log`).get() as { n: number }).n).toBe(0);
  });

  it("leaves rows that already have an owner alone", () => {
    const d = legacyDb();
    d.exec(`
      INSERT INTO users (id, username) VALUES ('u1', 'alice'), ('u2', 'bob');
      INSERT INTO apps (id, created_by, owner_user_id) VALUES ('a1', 'alice', 'u2');
    `);
    backfillOwnerUserIds(d);
    expect((d.prepare(`SELECT owner_user_id AS o FROM apps`).get() as { o: string }).o).toBe("u2");
  });
});

describe("migrate() on an installation from before S13", () => {
  beforeEach(() => {
    migrate();
    db.exec("DELETE FROM apps");
    db.exec("DELETE FROM users");
    db.exec("DELETE FROM audit_log");
    // Put the schema back to what an older release left behind.
    const cols = db.prepare("PRAGMA table_info(apps)").all() as Array<{ name: string }>;
    if (cols.some((c) => c.name === "owner_user_id")) db.exec("ALTER TABLE apps DROP COLUMN owner_user_id");
  });

  function seedLegacyApp(id: string, createdBy: string | null) {
    db.prepare(`INSERT INTO apps (id, api_key, name, created_by) VALUES (?, ?, ?, ?)`).run(
      id, `rwy_${id}`, `app ${id}`, createdBy
    );
  }
  const ownerCol = (id: string) =>
    (db.prepare(`SELECT owner_user_id AS o FROM apps WHERE id = ?`).get(id) as { o: string | null }).o;

  it("links by name once, reports the orphan, and keeps created_by for a rollback", async () => {
    const alice = await createUser("alice", "pw-alice-123456", "member");
    seedLegacyApp("x1", "alice");
    seedLegacyApp("x2", "nobody");
    seedLegacyApp("x3", null);

    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    migrate();
    warn.mockRestore();

    expect(ownerCol("x1")).toBe(alice.id);
    expect(ownerCol("x2")).toBeNull();
    expect(ownerCol("x3")).toBeNull();
    expect(getApp("x1")!.created_by).toBe("alice");
    expect(getApp("x2")!.created_by).toBe("nobody");
    const audit = db.prepare(`SELECT detail FROM audit_log WHERE action = 'app_owner_unlinked'`).all();
    expect(audit).toHaveLength(1);
  });

  it("is idempotent: a second start changes nothing and writes no second audit line", async () => {
    await createUser("alice", "pw-alice-123456", "member");
    seedLegacyApp("x1", "alice");
    seedLegacyApp("x2", "nobody");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    migrate();
    const before = db.prepare(`SELECT id, owner_user_id FROM apps ORDER BY id`).all();
    migrate();
    warn.mockRestore();
    expect(db.prepare(`SELECT id, owner_user_id FROM apps ORDER BY id`).all()).toEqual(before);
    expect(db.prepare(`SELECT COUNT(*) AS n FROM audit_log WHERE action = 'app_owner_unlinked'`).get()).toEqual({ n: 1 });
  });

  it("never hands an ownerless app to an account that takes the old name later", async () => {
    seedLegacyApp("x2", "dave"); // dave does not exist at migration time
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    migrate();
    const newDave = await createUser("dave", "pw-dave-123456", "member");
    migrate();
    warn.mockRestore();
    expect(ownerCol("x2")).toBeNull();
    expect(isAppOwner(newDave, getApp("x2")!)).toBe(false);
  });
});

describe("createApp and deleteUser", () => {
  beforeEach(() => {
    migrate();
    db.exec("DELETE FROM apps");
    db.exec("DELETE FROM users");
  });

  it("records the owner by id, and a bare name is resolved once", async () => {
    const alice = await createUser("alice", "pw-alice-123456", "member");
    const byObject = createApp({ id: alice.id, username: alice.username });
    const byName = createApp("alice");
    const byUnknown = createApp("ghost");
    expect(byObject.owner_user_id).toBe(alice.id);
    expect(byName.owner_user_id).toBe(alice.id);
    expect(byUnknown.owner_user_id).toBeNull();
    expect(createApp().owner_user_id).toBeNull();
  });

  it("deleting a user leaves their apps without an owner, in one step", async () => {
    const alice = await createUser("alice", "pw-alice-123456", "member");
    const bob = await createUser("bob", "pw-bob-123456", "member");
    const a1 = createApp(alice);
    const a2 = createApp(alice);
    const b1 = createApp(bob);
    updateApp(a1.id, { name: "keep me" });

    expect(deleteUser(alice.id)).toBe(2);

    expect(getApp(a1.id)).toBeDefined(); // not deleted
    expect(getApp(a1.id)!.owner_user_id).toBeNull();
    expect(getApp(a2.id)!.owner_user_id).toBeNull();
    expect(getApp(b1.id)!.owner_user_id).toBe(bob.id);
    expect(ownerUsernameOf(getApp(a1.id)!)).toBeNull();
    expect(deleteUser("no-such-id")).toBeNull();
  });

  it("a renamed account keeps its apps: ownership follows the id", async () => {
    const alice = await createUser("alice", "pw-alice-123456", "member");
    const app1 = createApp(alice);
    db.prepare(`UPDATE users SET username = 'alice2' WHERE id = ?`).run(alice.id);
    expect(isAppOwner(alice, getApp(app1.id)!)).toBe(true);
    expect(ownerUsernameOf(getApp(app1.id)!)).toBe("alice2");
  });
});
