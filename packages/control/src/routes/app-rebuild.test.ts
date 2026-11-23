/**
 * Rights around "rebuild this app": the owner may rebuild their own app,
 * nobody else's; an admin may rebuild any; CSRF and the one-run-at-a-time
 * limit stay in force; every run is audited. Drives the real app (CSRF and
 * session middleware included) against an in-memory database; only the
 * rebuild runner itself is replaced, so no Docker or Trivy is needed.
 */
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const startRebuildRun = vi.hoisted(() => vi.fn());
const activeRebuildRun = vi.hoisted(() => vi.fn(() => null as { runId: number; appIds: string[] | null } | null));

vi.mock("../deploy/rebuild.js", async (importOriginal) => {
  const real = await importOriginal<typeof import("../deploy/rebuild.js")>();
  return { ...real, startRebuildRun, activeRebuildRun };
});

import { app } from "../app.js";
import { db, migrate } from "../db/index.js";
import { createApp, updateApp } from "../db/apps.js";
import { createSession } from "../db/sessions.js";
import { createUser } from "../db/users.js";
import { deleteQuarantine, saveQuarantine } from "../db/quarantine.js";
import { RebuildBusyError } from "../deploy/rebuild.js";

const CSRF = "test-csrf-token";
let sessions: Record<string, string> = {};
let ownApp = "";
let otherApp = "";
let orphanApp = "";
let noImageApp = "";

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
  const b = createApp("bob");
  updateApp(b.id, { image_tag: "runway/b:1", name: "Bob blog" });
  otherApp = b.id;
  const o = createApp(); // pre-v0.3 style row, no owner
  updateApp(o.id, { image_tag: "runway/o:1", name: "Orphan" });
  orphanApp = o.id;
  const n = createApp("alice");
  updateApp(n.id, { name: "Never deployed" });
  noImageApp = n.id;
});

beforeEach(() => {
  startRebuildRun.mockReset();
  startRebuildRun.mockReturnValue(41);
  activeRebuildRun.mockReset();
  activeRebuildRun.mockReturnValue(null);
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

function get(path: string, who: string) {
  return app.request(path, { headers: { cookie: `runway_session=${sessions[who]}` } });
}

const loc = (r: Response) => r.headers.get("location");
const auditRows = (action: string) =>
  db.prepare(`SELECT username, detail FROM audit_log WHERE action = ?`).all(action) as Array<{ username: string; detail: string }>;

describe("POST /apps/:id/rebuild", () => {
  it("lets the owner rebuild their own app and lands on the app page", async () => {
    const r = await post(`/apps/${ownApp}/rebuild`, "alice");
    expect(r.status).toBe(302);
    expect(loc(r)).toBe(`/apps/${ownApp}?rebuild=started#deploys`);
    expect(startRebuildRun).toHaveBeenCalledTimes(1);
    expect(startRebuildRun.mock.calls[0]![0]).toMatchObject({ trigger: "manual", appIds: [ownApp] });
    expect(auditRows("app_rebuild_started").some((a) => a.username === "alice" && a.detail.includes("by owner"))).toBe(true);
  });

  it("refuses another member's app (IDOR) without starting anything", async () => {
    const r = await post(`/apps/${otherApp}/rebuild`, "alice");
    expect(loc(r)).toBe("/?forbidden=1");
    expect(startRebuildRun).not.toHaveBeenCalled();
  });

  it("keeps ownerless apps admin-only", async () => {
    const r = await post(`/apps/${orphanApp}/rebuild`, "alice");
    expect(loc(r)).toBe("/?forbidden=1");
    expect(startRebuildRun).not.toHaveBeenCalled();
  });

  it("lets an admin rebuild any app and keeps the admin's old landing page", async () => {
    const r = await post(`/apps/${otherApp}/rebuild`, "root");
    expect(loc(r)).toBe("/rebuild?started=1");
    expect(startRebuildRun.mock.calls[0]![0]).toMatchObject({ appIds: [otherApp] });
  });

  it("applies the one-run-at-a-time limit to owners and admins alike", async () => {
    startRebuildRun.mockImplementation(() => {
      throw new RebuildBusyError();
    });
    expect(loc(await post(`/apps/${ownApp}/rebuild`, "alice"))).toBe(`/apps/${ownApp}?rebuild=busy#deploys`);
    expect(loc(await post(`/apps/${ownApp}/rebuild`, "root"))).toBe("/rebuild?busy=1");
  });

  it("does not start a rebuild for an app that was never deployed", async () => {
    const r = await post(`/apps/${noImageApp}/rebuild`, "alice");
    expect(loc(r)).toBe(`/apps/${noImageApp}?rebuild=blocked#deploys`);
    expect(startRebuildRun).not.toHaveBeenCalled();
  });

  it("rejects a request without the CSRF token", async () => {
    const r = await post(`/apps/${ownApp}/rebuild`, "alice", { csrf: false });
    expect(r.status).toBe(403);
    expect(startRebuildRun).not.toHaveBeenCalled();
  });

  it("sends an anonymous visitor to the login", async () => {
    const r = await post(`/apps/${ownApp}/rebuild`, null);
    expect(loc(r)).toBe("/login");
    expect(startRebuildRun).not.toHaveBeenCalled();
  });

  it("audits how the run ended", async () => {
    await post(`/apps/${ownApp}/rebuild`, "alice");
    const opts = startRebuildRun.mock.calls[0]![0] as { onFinished: (r: unknown[]) => void };
    opts.onFinished([{ app_id: ownApp, app_name: null, outcome: "blocked", before: null, after: null, detail: "new critical" }]);
    const rows = auditRows("app_rebuild_finished");
    expect(rows.some((a) => a.username === "alice" && a.detail.includes(`${ownApp} run 41: blocked (new critical)`))).toBe(true);
  });
});

describe("GET /apps/:id/rebuild-status", () => {
  it("answers the owner and turns another member away", async () => {
    expect((await get(`/apps/${ownApp}/rebuild-status`, "alice")).status).toBe(200);
    const r = await get(`/apps/${ownApp}/rebuild-status`, "bob");
    expect(loc(r)).toBe("/?forbidden=1");
  });

  it("only talks about this app while a run is busy", async () => {
    activeRebuildRun.mockReturnValue({ runId: 3, appIds: [otherApp] });
    expect(await (await get(`/apps/${ownApp}/rebuild-status`, "alice")).text()).not.toContain("Rebuild running");
    activeRebuildRun.mockReturnValue({ runId: 3, appIds: [ownApp] });
    expect(await (await get(`/apps/${ownApp}/rebuild-status`, "alice")).text()).toContain("Rebuild running");
  });
});

describe("GET /apps/:id (app page)", () => {
  it("shows the owner a header, the four tabs and a rebuild button", async () => {
    const html = await (await get(`/apps/${ownApp}`, "alice")).text();
    expect(html).toContain("app-head");
    for (const tab of ["deploys", "security", "config", "access"]) expect(html).toContain(`id="tab-${tab}"`);
    expect(html).toContain(`action="/apps/${ownApp}/rebuild"`);
    expect(html).not.toContain("Owner alice"); // owner name is for admins
  });

  it("does not show the page of someone else's app", async () => {
    const r = await get(`/apps/${otherApp}`, "alice");
    expect(loc(r)).toBe("/?forbidden=1");
  });

  it("explains why the button is missing while a run is busy", async () => {
    activeRebuildRun.mockReturnValue({ runId: 3, appIds: null });
    const html = await (await get(`/apps/${ownApp}`, "alice")).text();
    expect(html).not.toContain(`action="/apps/${ownApp}/rebuild"`);
    expect(html).toContain("Only one runs at a time");
  });
});

describe("GET /apps/:id with an exploited vulnerability", () => {
  beforeAll(() => {
    saveQuarantine({
      app_id: ownApp,
      state: "grace",
      kev_first_seen: { "CVE-2026-0001": new Date(Date.now() - 86_400_000).toISOString() },
      attempt_at: null,
      quarantined_at: null,
    });
  });

  it("puts the countdown block above the tabs, with the rebuild step for the owner", async () => {
    const html = await (await get(`/apps/${ownApp}`, "alice")).text();
    expect(html).toContain('id="kev"');
    expect(html).toMatch(/Goes offline in \d/);
    expect(html.indexOf('id="kev"')).toBeLessThan(html.indexOf('class="tabs"'));
    expect(html).toContain("Only an admin can extend the term");
    expect(html).not.toContain('name="reason"'); // the exemption form is admin-only
  });

  it("gives the admin the exemption form, collapsed", async () => {
    const html = await (await get(`/apps/${ownApp}`, "root")).text();
    expect(html).toContain("Grant an exemption");
    expect(html).toMatch(/<details class="exempt">/);
    expect(html).toContain("Owner alice");
  });

  it("drops the block again once the term is gone", async () => {
    deleteQuarantine(ownApp);
    const html = await (await get(`/apps/${ownApp}`, "alice")).text();
    expect(html).not.toContain('id="kev"');
  });
});
