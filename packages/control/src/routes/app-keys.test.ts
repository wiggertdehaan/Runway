/**
 * App API keys stored as hashes, shown once, and rotatable (S10, S11). Drives
 * the real app (CSRF and session middleware included) against an in-memory
 * database.
 */
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { app } from "../app.js";
import { db, migrate } from "../db/index.js";
import { createApp, getApp, getAppByKey, previousKeyActive, rotateAppKey, updateApp } from "../db/apps.js";
import { createSession } from "../db/sessions.js";
import { createUser } from "../db/users.js";
import { clearKeyReveals, peekKey } from "../util/key-reveal.js";
import { resetTokenLimits } from "../middleware/token-limit.js";
import { hashToken } from "../util/token-hash.js";

const CSRF = "test-csrf-token";
let sessions: Record<string, string> = {};
let aliceId = "";

beforeAll(async () => {
  migrate();
  process.env.DASHBOARD_DOMAIN = "runway.example.com";
  const root = await createUser("root", "pw-root-123456", "admin");
  const alice = await createUser("alice", "pw-alice-123456", "member");
  const bob = await createUser("bob", "pw-bob-123456", "member");
  aliceId = alice.id;
  sessions = {
    root: createSession(root.id).token,
    alice: createSession(alice.id).token,
    bob: createSession(bob.id).token,
  };
});

beforeEach(() => {
  clearKeyReveals();
  resetTokenLimits();
  db.exec("DELETE FROM audit_log");
});

function post(path: string, who: string | null, form = "", opts: { csrf?: boolean } = {}) {
  const csrf = opts.csrf ?? true;
  const cookie = [who ? `runway_session=${sessions[who]}` : "", csrf ? `runway_csrf=${CSRF}` : ""]
    .filter(Boolean)
    .join("; ");
  return app.request(path, {
    method: "POST",
    headers: { cookie, "content-type": "application/x-www-form-urlencoded" },
    body: `${csrf ? `_csrf=${CSRF}&` : ""}${form}`,
  });
}
const get = (path: string, who: string) =>
  app.request(path, { headers: { cookie: `runway_session=${sessions[who]}` } });
const api = (key: string, path = "/app") =>
  app.request(`/api/v1${path}`, { headers: { authorization: `Bearer ${key}` } });
const loc = (r: Response) => r.headers.get("location") ?? "";

/** A configured app owned by alice, with its (one-time) key. */
function makeApp(owner: string | undefined = "alice") {
  const a = createApp(owner);
  updateApp(a.id, { name: "shop", runtime: "node" } as never);
  return { id: a.id, key: a.api_key };
}

describe("stored as a hash", () => {
  it("createApp hands the key back once and stores only its hash", () => {
    const a = createApp("alice");
    expect(a.api_key.startsWith("rwy_")).toBe(true);
    const row = db.prepare(`SELECT * FROM apps WHERE id = ?`).get(a.id) as any;
    expect(row.api_key).toBe(`hashed:${a.id}`);
    expect(row.api_key_hash).toBe(hashToken(a.api_key));
    expect(row.api_key_hint).toBe(a.api_key.slice(-4));
    expect(JSON.stringify(row)).not.toContain(a.api_key);
    // Reading the app again never gives the key back.
    expect(getApp(a.id)!.api_key).toBe(`hashed:${a.id}`);
  });

  it("the key still authenticates, and a different or unknown key does not", async () => {
    const a = makeApp();
    const b = makeApp("bob");
    expect((await api(a.key)).status).toBe(200);
    expect(((await (await api(a.key)).json()) as any).id).toBe(a.id);
    expect(((await (await api(b.key)).json()) as any).id).toBe(b.id);
    expect((await api("rwy_nope")).status).toBe(401);
    expect((await api(`${a.key}x`)).status).toBe(401);
    expect((await api(`hashed:${a.id}`)).status).toBe(401);
  });

  it("takes over a row that still has a plaintext key and no hash (old process, restored backup)", () => {
    const key = "rwy_LEGACYLEGACYLEGACYLEGACYLEGACY12";
    db.prepare(`INSERT INTO apps (id, api_key, name) VALUES ('legacy1', ?, 'old')`).run(key);
    expect(getAppByKey(key)?.id).toBe("legacy1");
    const row = db.prepare(`SELECT * FROM apps WHERE id = 'legacy1'`).get() as any;
    expect(row.api_key).toBe("hashed:legacy1");
    expect(row.api_key_hash).toBe(hashToken(key));
    expect(JSON.stringify(row)).not.toContain(key);
    expect(getAppByKey(key)?.id).toBe("legacy1");
  });

  it("the whole apps table holds no plaintext key after creating and rotating", () => {
    const a = makeApp();
    const r = rotateAppKey(a.id, 60)!;
    const dump = JSON.stringify(db.prepare(`SELECT * FROM apps`).all());
    expect(dump).not.toContain(a.key);
    expect(dump).not.toContain(r.key);
  });
});

describe("rotation", () => {
  it("replaces the key at once when no overlap is asked for", async () => {
    const a = makeApp();
    const r = rotateAppKey(a.id, 0)!;
    expect(r.key).not.toBe(a.key);
    expect((await api(a.key)).status).toBe(401);
    expect((await api(r.key)).status).toBe(200);
    expect(previousKeyActive(getApp(a.id)!)).toBe(false);
  });

  it("keeps the old key working for the overlap, then not", async () => {
    const a = makeApp();
    const t0 = Date.now();
    const r = rotateAppKey(a.id, 60, t0)!;
    expect(getAppByKey(a.key, t0 + 59 * 60_000)?.id).toBe(a.id);
    expect(getAppByKey(a.key, t0 + 61 * 60_000)).toBeUndefined();
    expect((await api(r.key)).status).toBe(200);
  });

  it("an overlap that has already run out does not let the old key in", () => {
    const a = makeApp();
    rotateAppKey(a.id, 30, Date.now() - 2 * 3600_000);
    expect(getAppByKey(a.key)).toBeUndefined();
  });

  it("there is never more than one extra key: rotating again ends the older overlap", () => {
    const a = makeApp();
    const r1 = rotateAppKey(a.id, 60)!;
    const r2 = rotateAppKey(a.id, 60)!;
    expect(getAppByKey(a.key)).toBeUndefined(); // the first key is gone
    expect(getAppByKey(r1.key)?.id).toBe(a.id); // the second is in its overlap
    expect(getAppByKey(r2.key)?.id).toBe(a.id);
  });

  it("caps the overlap at a week and ignores a negative or silly value", () => {
    const a = makeApp();
    const t0 = Date.now();
    rotateAppKey(a.id, 10_000_000, t0);
    const row = db.prepare(`SELECT prev_key_expires_at FROM apps WHERE id = ?`).get(a.id) as any;
    const until = Date.parse(`${row.prev_key_expires_at.replace(" ", "T")}Z`);
    expect(until - t0).toBeLessThanOrEqual(7 * 24 * 3600_000 + 1000);
    const b = makeApp();
    rotateAppKey(b.id, -5);
    expect(getAppByKey(b.key)).toBeUndefined();
  });

  it("is a no-op for an app that does not exist", () => {
    expect(rotateAppKey("nope", 0)).toBeNull();
  });
});

describe("rotating from the dashboard", () => {
  it("lets the owner rotate, shows the new key to them, and audits without the key", async () => {
    const a = makeApp();
    const res = await post(`/apps/${a.id}/key/rotate`, "alice", "grace=0");
    expect(res.status).toBe(302);
    expect(loc(res)).toContain(`/apps/${a.id}`);
    expect((await api(a.key)).status).toBe(401);
    const fresh = peekKey(a.id, aliceId)!;
    expect(fresh.startsWith("rwy_")).toBe(true);
    expect((await api(fresh)).status).toBe(200);

    const page = await (await get(`/apps/${a.id}`, "alice")).text();
    expect(page).toContain(fresh);
    expect(page).toContain("not shown again");
    // Shown again on a second visit (it is held for a few minutes), then gone once it is hidden.
    expect(await (await get(`/apps/${a.id}`, "alice")).text()).toContain(fresh);
    await post(`/apps/${a.id}/key/hide`, "alice");
    expect(await (await get(`/apps/${a.id}`, "alice")).text()).not.toContain(fresh);

    const rows = db.prepare(`SELECT * FROM audit_log WHERE action = 'app_key_rotated'`).all() as any[];
    expect(rows).toHaveLength(1);
    expect(JSON.stringify(db.prepare(`SELECT * FROM audit_log`).all())).not.toContain(fresh);
  });

  it("an administrator who rotates sees the key; the owner does not get it from the page", async () => {
    const a = makeApp();
    await post(`/apps/${a.id}/key/rotate`, "root", "grace=0");
    const fresh = peekKey(a.id, (await (async () => {
      const r = db.prepare(`SELECT id FROM users WHERE username = 'root'`).get() as any;
      return r;
    })()).id)!;
    expect(fresh).toBeTruthy();
    expect(await (await get(`/apps/${a.id}`, "root")).text()).toContain(fresh);
    expect(await (await get(`/apps/${a.id}`, "alice")).text()).not.toContain(fresh);
    const row = db.prepare(`SELECT detail FROM audit_log WHERE action = 'app_key_rotated'`).get() as any;
    expect(row.detail).toContain("by administrator");
  });

  it("offers an overlap, tells the owner it is running, and can end it", async () => {
    const a = makeApp();
    await post(`/apps/${a.id}/key/rotate`, "alice", "grace=1440");
    expect((await api(a.key)).status).toBe(200);
    const page = await (await get(`/apps/${a.id}`, "alice")).text();
    expect(page).toContain("still works until");
    await post(`/apps/${a.id}/key/end-overlap`, "alice");
    expect((await api(a.key)).status).toBe(401);
  });

  it("only takes the overlaps the form offers", async () => {
    const a = makeApp();
    await post(`/apps/${a.id}/key/rotate`, "alice", "grace=99999999");
    expect((await api(a.key)).status).toBe(401); // fell back to "stops now"
  });

  it("refuses somebody else's app, an anonymous caller and a missing CSRF token", async () => {
    const a = makeApp();
    const bob = await post(`/apps/${a.id}/key/rotate`, "bob", "grace=0");
    expect(loc(bob)).toContain("forbidden");
    expect((await api(a.key)).status).toBe(200);
    const anon = await post(`/apps/${a.id}/key/rotate`, null, "grace=0");
    expect(loc(anon)).toMatch(/login/);
    expect((await api(a.key)).status).toBe(200);
    const noCsrf = await post(`/apps/${a.id}/key/rotate`, "alice", "grace=0", { csrf: false });
    expect(noCsrf.status).toBe(403);
    expect((await api(a.key)).status).toBe(200);
    for (const p of ["end-overlap", "hide"]) {
      expect(loc(await post(`/apps/${a.id}/key/${p}`, "bob"))).toContain("forbidden");
    }
  });
});

describe("showing a new app's key once", () => {
  it("shows it to its creator on the home page for a while, and to nobody else", async () => {
    const res = await post("/apps", "alice");
    expect(res.status).toBe(302);
    const id = decodeURIComponent(loc(res).split("new=")[1]!);
    const key = peekKey(id, aliceId)!;
    expect(key.startsWith("rwy_")).toBe(true);
    expect((await api(key)).status).toBe(200);
    expect(await (await get("/", "alice")).text()).toContain(key);
    expect(await (await get("/", "root")).text()).not.toContain(key);
    expect(JSON.stringify(db.prepare(`SELECT * FROM apps`).all())).not.toContain(key);
  });

  it("after that the home page gives a placeholder and a way to rotate", async () => {
    const res = await post("/apps", "alice");
    const id = decodeURIComponent(loc(res).split("new=")[1]!);
    const key = peekKey(id, aliceId)!;
    clearKeyReveals();
    const html = await (await get("/", "alice")).text();
    expect(html).not.toContain(key);
    expect(html).toContain("&lt;paste your API key here&gt;");
    expect(html).toContain("Rotate the key");
  });
});
