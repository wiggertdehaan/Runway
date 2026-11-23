/**
 * Rights around "rescan this app": the owner may rescan their own app,
 * nobody else's; an admin may rescan any; an app without an owner stays
 * admin-only; CSRF and the one-at-a-time limit stay in force; every rescan
 * is audited. Drives the real app (CSRF and session middleware included)
 * against an in-memory database; only the Trivy rescan itself is replaced.
 */
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const rescanApp = vi.hoisted(() => vi.fn(async () => undefined));
vi.mock("../deploy/periodic-scanner.js", async (importOriginal) => {
  const real = await importOriginal<typeof import("../deploy/periodic-scanner.js")>();
  return { ...real, rescanApp };
});

import { app } from "../app.js";
import { db, migrate } from "../db/index.js";
import { createApp, updateApp } from "../db/apps.js";
import { createSession } from "../db/sessions.js";
import { createUser } from "../db/users.js";
import { endRescan, tryBeginRescan, activeRescan } from "../deploy/rescan-guard.js";

const CSRF = "test-csrf-token";
let sessions: Record<string, string> = {};
let ownApp = "";
let otherApp = "";
let orphanApp = "";
let noImageApp = "";
let stoppedApp = "";

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
  const mk = (owner: string | undefined, extra: Record<string, unknown>) => {
    const a = createApp(owner);
    updateApp(a.id, extra as never);
    return a.id;
  };
  ownApp = mk("alice", { image_tag: "runway/a:1", name: "Alice shop", status: "running" });
  otherApp = mk("bob", { image_tag: "runway/b:1", name: "Bob blog", status: "running" });
  orphanApp = mk(undefined, { image_tag: "runway/o:1", name: "Orphan", status: "running" });
  noImageApp = mk("alice", { name: "Never deployed", status: "running" });
  stoppedApp = mk("alice", { image_tag: "runway/s:1", name: "Stopped", status: "stopped" });
});

beforeEach(() => {
  rescanApp.mockReset();
  rescanApp.mockResolvedValue(undefined);
  const a = activeRescan();
  if (a) endRescan(a);
});

function post(path: string, who: string | null, opts: { csrf?: boolean } = {}) {
  const csrf = opts.csrf ?? true;
  const cookie = [who ? `runway_session=${sessions[who]}` : "", csrf ? `runway_csrf=${CSRF}` : ""].filter(Boolean).join("; ");
  return app.request(path, {
    method: "POST",
    headers: { cookie, "content-type": "application/x-www-form-urlencoded" },
    body: csrf ? `_csrf=${CSRF}` : "",
  });
}
const get = (path: string, who: string) => app.request(path, { headers: { cookie: `runway_session=${sessions[who]}` } });
const loc = (r: Response) => r.headers.get("location");
const auditRows = (action: string) =>
  db.prepare(`SELECT username, detail FROM audit_log WHERE action = ?`).all(action) as Array<{ username: string; detail: string }>;

describe("POST /apps/:id/rescan", () => {
  it("lets the owner rescan their own app and lands on the Security tab, audited as by owner", async () => {
    const r = await post(`/apps/${ownApp}/rescan`, "alice");
    expect(r.status).toBe(302);
    expect(loc(r)).toBe(`/apps/${ownApp}?saved=1#scan`);
    expect(rescanApp).toHaveBeenCalledTimes(1);
    expect(auditRows("app_rescanned").some((a) => a.username === "alice" && a.detail === `${ownApp} (by owner)`)).toBe(true);
  });

  it("lets an admin rescan any app, audited without 'by owner'", async () => {
    const r = await post(`/apps/${otherApp}/rescan`, "root");
    expect(loc(r)).toBe(`/apps/${otherApp}?saved=1#scan`);
    expect(rescanApp).toHaveBeenCalledTimes(1);
    expect(auditRows("app_rescanned").some((a) => a.username === "root" && a.detail === otherApp)).toBe(true);
  });

  it("refuses another member's app (IDOR) without scanning", async () => {
    const r = await post(`/apps/${otherApp}/rescan`, "alice");
    expect(loc(r)).toBe("/?forbidden=1");
    expect(rescanApp).not.toHaveBeenCalled();
  });

  it("keeps ownerless apps admin-only", async () => {
    expect(loc(await post(`/apps/${orphanApp}/rescan`, "alice"))).toBe("/?forbidden=1");
    expect(rescanApp).not.toHaveBeenCalled();
    expect(loc(await post(`/apps/${orphanApp}/rescan`, "root"))).toBe(`/apps/${orphanApp}?saved=1#scan`);
  });

  it("rejects a request without the CSRF token and scans nothing", async () => {
    const r = await post(`/apps/${ownApp}/rescan`, "alice", { csrf: false });
    expect(r.status).toBe(403);
    expect(rescanApp).not.toHaveBeenCalled();
  });

  it("sends an anonymous visitor to the login page and scans nothing", async () => {
    const r = await post(`/apps/${ownApp}/rescan`, null);
    expect(r.status).toBe(302);
    expect(loc(r) ?? "").toMatch(/login/);
    expect(rescanApp).not.toHaveBeenCalled();
  });

  it("does not scan an app that was never deployed or is not running", async () => {
    expect(loc(await post(`/apps/${noImageApp}/rescan`, "alice"))).toBe(`/apps/${noImageApp}?rescan=blocked#scan`);
    expect(loc(await post(`/apps/${stoppedApp}/rescan`, "alice"))).toBe(`/apps/${stoppedApp}?rescan=blocked#scan`);
    expect(rescanApp).not.toHaveBeenCalled();
  });

  it("allows one rescan at a time, for owners and admins alike", async () => {
    expect(tryBeginRescan(otherApp)).toBe(true);
    expect(loc(await post(`/apps/${ownApp}/rescan`, "alice"))).toBe(`/apps/${ownApp}?rescan=busy#scan`);
    expect(loc(await post(`/apps/${ownApp}/rescan`, "root"))).toBe(`/apps/${ownApp}?rescan=busy#scan`);
    expect(rescanApp).not.toHaveBeenCalled();
  });

  it("frees the slot even when the scan throws", async () => {
    rescanApp.mockRejectedValueOnce(new Error("trivy down"));
    try {
      await post(`/apps/${ownApp}/rescan`, "alice");
    } catch {
      /* the error may surface as a 500 or a throw; either way the slot must be free */
    }
    expect(activeRescan()).toBeNull();
  });
});

describe("app page rescan button", () => {
  it("shows the owner a Rescan button on the Security tab", async () => {
    const html = await (await get(`/apps/${ownApp}`, "alice")).text();
    expect(html).toContain(`action="/apps/${ownApp}/rescan"`);
  });

  it("shows no button for an app that cannot be rescanned", async () => {
    const html = await (await get(`/apps/${stoppedApp}`, "alice")).text();
    expect(html).not.toContain(`/apps/${stoppedApp}/rescan"`);
  });

  it("shows the busy note after a refused second rescan", async () => {
    const html = await (await get(`/apps/${ownApp}?rescan=busy`, "alice")).text();
    expect(html).toContain("A rescan is already running");
  });
});
