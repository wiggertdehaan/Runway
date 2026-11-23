/**
 * Per-app container hardening (S08): POST /apps/:id/hardening is admin-only,
 * CSRF enforced, audited, and validates the profile. Also checks the card on
 * the Config tab, the API status field and the migration defaults. Drives the
 * real app (session + CSRF middleware included) against an in-memory database.
 */
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { app } from "../app.js";
import { db, migrate } from "../db/index.js";
import { createApp, getApp, updateApp } from "../db/apps.js";
import { createSession } from "../db/sessions.js";
import { createUser } from "../db/users.js";

const CSRF = "test-csrf-token";
let sessions: Record<string, string> = {};
let ownApp = "";
let ownKey = "";

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
  const a = createApp("alice");
  updateApp(a.id, { image_tag: "runway/a:1", name: "Alice shop", runtime: "node" });
  ownApp = a.id;
  ownKey = a.api_key;
});

afterEach(() => {
  updateApp(ownApp, { hardening_profile: null, readonly_rootfs: 0 });
  delete process.env.RUNWAY_HARDENING;
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
const get = (path: string, who: string) => app.request(path, { headers: { cookie: `runway_session=${sessions[who]}` } });
const loc = (r: Response) => r.headers.get("location");
const row = () => getApp(ownApp)!;
const auditCount = () =>
  (db.prepare(`SELECT COUNT(*) AS n FROM audit_log WHERE action = 'app_hardening_changed'`).get() as { n: number }).n;

describe("migration", () => {
  it("adds the two columns with safe defaults (inherit the server default, writable rootfs)", () => {
    const cols = db.prepare("PRAGMA table_info(apps)").all() as Array<{ name: string; dflt_value: string | null }>;
    expect(cols.some((c) => c.name === "hardening_profile")).toBe(true);
    expect(cols.find((c) => c.name === "readonly_rootfs")?.dflt_value).toBe("0");
    const fresh = createApp("alice");
    expect(getApp(fresh.id)!.hardening_profile).toBeNull();
    expect(getApp(fresh.id)!.readonly_rootfs).toBe(0);
  });

  it("is idempotent", () => {
    expect(() => migrate()).not.toThrow();
    expect(() => migrate()).not.toThrow();
  });
});

describe("POST /apps/:id/hardening", () => {
  it("lets an admin set a profile and the read-only rootfs, and audits it", async () => {
    const before = auditCount();
    const r = await post(`/apps/${ownApp}/hardening`, "root", { profile: "strict", readonly: "1" });
    expect(loc(r)).toBe(`/apps/${ownApp}?saved=1#hardening`);
    expect(row().hardening_profile).toBe("strict");
    expect(row().readonly_rootfs).toBe(1);
    expect(auditCount()).toBe(before + 1);
    const detail = (db.prepare(`SELECT detail FROM audit_log WHERE action = 'app_hardening_changed' ORDER BY id DESC LIMIT 1`).get() as { detail: string }).detail;
    expect(detail).toContain("strict");
    expect(detail).toContain("on");
  });

  it("an empty profile means the server default, and an unchecked box means writable", async () => {
    updateApp(ownApp, { hardening_profile: "relaxed", readonly_rootfs: 1 });
    await post(`/apps/${ownApp}/hardening`, "root", { profile: "" });
    expect(row().hardening_profile).toBeNull();
    expect(row().readonly_rootfs).toBe(0);
  });

  it("ignores an unknown profile instead of guessing (a typo must not weaken anything)", async () => {
    updateApp(ownApp, { hardening_profile: "strict" });
    const before = auditCount();
    const r = await post(`/apps/${ownApp}/hardening`, "root", { profile: "off" });
    expect(loc(r)).toBe(`/apps/${ownApp}#hardening`);
    expect(row().hardening_profile).toBe("strict");
    expect(auditCount()).toBe(before);
  });

  it("refuses the app's own owner and changes nothing", async () => {
    const before = auditCount();
    const r = await post(`/apps/${ownApp}/hardening`, "alice", { profile: "relaxed", readonly: "1" });
    expect(loc(r)).toBe("/");
    expect(row().hardening_profile).toBeNull();
    expect(row().readonly_rootfs).toBe(0);
    expect(auditCount()).toBe(before);
  });

  it("refuses another member and changes nothing", async () => {
    const before = auditCount();
    const r = await post(`/apps/${ownApp}/hardening`, "bob", { profile: "relaxed", readonly: "1" });
    // requireAppAccess turns a member who does not own the app away first.
    expect(loc(r)).toBe("/?forbidden=1");
    expect(row().hardening_profile).toBeNull();
    expect(row().readonly_rootfs).toBe(0);
    expect(auditCount()).toBe(before);
  });

  it("rejects a request without the CSRF token", async () => {
    const r = await post(`/apps/${ownApp}/hardening`, "root", { profile: "relaxed" }, false);
    expect(r.status).toBe(403);
    expect(row().hardening_profile).toBeNull();
  });

  it("sends an anonymous visitor to the login page", async () => {
    const r = await post(`/apps/${ownApp}/hardening`, null, { profile: "relaxed" });
    expect([301, 302, 303, 401, 403]).toContain(r.status);
    expect(row().hardening_profile).toBeNull();
  });

  it("does nothing for an unknown app", async () => {
    const r = await post(`/apps/nope/hardening`, "root", { profile: "strict" });
    expect(loc(r)).toBe("/");
  });
});

describe("Config tab card", () => {
  it("shows an admin the form with the current profile selected", async () => {
    updateApp(ownApp, { hardening_profile: "strict", readonly_rootfs: 1 });
    const html = await (await get(`/apps/${ownApp}`, "root")).text();
    expect(html).toContain("Container hardening");
    expect(html).toContain(`/apps/${ownApp}/hardening"`);
    expect(html).toMatch(/<option value="strict" selected>/);
    expect(html).toMatch(/name="readonly" value="1" checked/);
    expect(html).toContain("next time the container is created");
  });

  it("shows the owner what applies, read-only, without a form", async () => {
    updateApp(ownApp, { hardening_profile: "strict" });
    const html = await (await get(`/apps/${ownApp}`, "alice")).text();
    expect(html).toContain("Container hardening");
    expect(html).toContain("Running profile: <b>strict</b>");
    expect(html).toContain("Set by an administrator");
    expect(html).not.toContain(`/apps/${ownApp}/hardening"`);
  });

  it("says so when the emergency brake overrides the app's profile", async () => {
    process.env.RUNWAY_HARDENING = "relaxed";
    updateApp(ownApp, { hardening_profile: "strict" });
    const html = await (await get(`/apps/${ownApp}`, "root")).text();
    expect(html).toContain("Running profile: <b>relaxed</b>");
    expect(html).toContain("RUNWAY_HARDENING=relaxed is set on this server");
  });
});

describe("GET /api/v1/app", () => {
  it("reports the profile in effect and the read-only flag", async () => {
    updateApp(ownApp, { hardening_profile: "strict", readonly_rootfs: 1 });
    const r = await app.request("/api/v1/app", { headers: { authorization: `Bearer ${ownKey}` } });
    expect(r.status).toBe(200);
    const body = (await r.json()) as { hardening: string; read_only_rootfs: boolean };
    expect(body.hardening).toBe("strict");
    expect(body.read_only_rootfs).toBe(true);
  });

  it("reports the default for an app without a profile", async () => {
    const r = await app.request("/api/v1/app", { headers: { authorization: `Bearer ${ownKey}` } });
    const body = (await r.json()) as { hardening: string; read_only_rootfs: boolean };
    expect(body.hardening).toBe("standard");
    expect(body.read_only_rootfs).toBe(false);
  });
});
