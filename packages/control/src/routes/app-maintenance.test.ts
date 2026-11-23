/**
 * The five "Automatic maintenance" switches keep their endpoints and their
 * rule: admin only, CSRF enforced, every change audited. Drives the real app
 * (session + CSRF middleware included) against an in-memory database.
 */
import { beforeAll, describe, expect, it } from "vitest";
import { app } from "../app.js";
import { db, migrate } from "../db/index.js";
import { createApp, getApp, updateApp } from "../db/apps.js";
import { createSession } from "../db/sessions.js";
import { createUser } from "../db/users.js";

const CSRF = "test-csrf-token";
let sessions: Record<string, string> = {};
let ownApp = "";

const SWITCHES = [
  { action: "auto-rebuild", col: "auto_rebuild", audit: "app_auto_rebuild_toggled" },
  { action: "auto-patch", col: "auto_patch_base", audit: "app_auto_patch_toggled" },
  { action: "auto-minor", col: "auto_minor_base", audit: "app_auto_minor_toggled" },
  { action: "auto-deps", col: "auto_update_deps", audit: "app_auto_deps_toggled" },
  { action: "auto-deps-major", col: "auto_update_deps_major", audit: "app_auto_deps_major_toggled" },
] as const;

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
  updateApp(a.id, { image_tag: "runway/a:1", name: "Alice shop" });
  ownApp = a.id;
});

function post(path: string, who: string | null, enabled: string, csrf = true) {
  const cookie = [who ? `runway_session=${sessions[who]}` : "", csrf ? `runway_csrf=${CSRF}` : ""].filter(Boolean).join("; ");
  return app.request(path, {
    method: "POST",
    headers: { cookie, "content-type": "application/x-www-form-urlencoded" },
    body: `enabled=${enabled}` + (csrf ? `&_csrf=${CSRF}` : ""),
  });
}
const get = (path: string, who: string) => app.request(path, { headers: { cookie: `runway_session=${sessions[who]}` } });
const loc = (r: Response) => r.headers.get("location");
const col = (name: string) => (getApp(ownApp) as unknown as Record<string, number>)[name]!;
const auditCount = (action: string) =>
  (db.prepare(`SELECT COUNT(*) AS n FROM audit_log WHERE action = ?`).get(action) as { n: number }).n;

describe.each(SWITCHES)("POST /apps/:id/$action", ({ action, col: column, audit }) => {
  it("lets an admin flip it both ways, writes the audit log and returns to the Security tab", async () => {
    const before = auditCount(audit);
    let r = await post(`/apps/${ownApp}/${action}`, "root", "1");
    expect(loc(r)).toBe(`/apps/${ownApp}?saved=1#scan`);
    expect(col(column)).toBe(1);
    r = await post(`/apps/${ownApp}/${action}`, "root", "0");
    expect(col(column)).toBe(0);
    expect(auditCount(audit)).toBe(before + 2);
  });

  it("refuses the app's own owner (switches are admin-only) and changes nothing", async () => {
    updateApp(ownApp, { [column]: 0 } as never);
    const before = auditCount(audit);
    const r = await post(`/apps/${ownApp}/${action}`, "alice", "1");
    expect(loc(r)).toBe("/");
    expect(col(column)).toBe(0);
    expect(auditCount(audit)).toBe(before);
  });

  it("refuses another member and changes nothing", async () => {
    updateApp(ownApp, { [column]: 0 } as never);
    const r = await post(`/apps/${ownApp}/${action}`, "bob", "1");
    expect(loc(r)).not.toBe(`/apps/${ownApp}?saved=1#scan`);
    expect(col(column)).toBe(0);
  });

  it("rejects a request without the CSRF token", async () => {
    updateApp(ownApp, { [column]: 0 } as never);
    const r = await post(`/apps/${ownApp}/${action}`, "root", "1", false);
    expect(r.status).toBe(403);
    expect(col(column)).toBe(0);
  });

  it("does nothing for an unknown app", async () => {
    const r = await post(`/apps/nope/${action}`, "root", "1");
    expect(loc(r)).toBe("/");
  });
});

describe("app page rendering", () => {
  it("shows an admin live switches that post to the five endpoints", async () => {
    const html = await (await get(`/apps/${ownApp}`, "root")).text();
    expect(html).toContain("Automatic maintenance");
    for (const s of SWITCHES) expect(html).toContain(`/apps/${ownApp}/${s.action}"`);
    expect(html).toContain('role="switch"');
    expect(html).not.toContain("(turn off)");
    expect(html).not.toContain("(turn on)");
  });

  it("shows the owner the state read-only, without any switch form", async () => {
    const html = await (await get(`/apps/${ownApp}`, "alice")).text();
    expect(html).toContain("Automatic maintenance");
    expect(html).toContain("Set by an administrator");
    for (const s of SWITCHES) expect(html).not.toContain(`/apps/${ownApp}/${s.action}"`);
  });
});
