/**
 * The two buttons on the Rebuild page. "Rebuild apps with issues" picks the
 * apps the weekly run would pick, plus those that switched automatic
 * rebuild off; "Rebuild all apps" needs the in-page confirmation. Both are
 * admin-only, CSRF-protected, one run at a time, and audited with their
 * mode and count. Drives the real app against an in-memory database; only
 * the run starter and the KEV list are replaced, so no Docker, Trivy or
 * network is needed.
 */
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const startRebuildRun = vi.hoisted(() => vi.fn());
const activeRebuildRunId = vi.hoisted(() => vi.fn(() => null as number | null));
const kev = vi.hoisted(() => ({ ids: new Set<string>(), stale: false }));

vi.mock("../deploy/rebuild.js", async (importOriginal) => {
  const real = await importOriginal<typeof import("../deploy/rebuild.js")>();
  return { ...real, startRebuildRun, activeRebuildRunId };
});
vi.mock("../deploy/kev.js", async (importOriginal) => {
  const real = await importOriginal<typeof import("../deploy/kev.js")>();
  return {
    ...real,
    getKevList: async () => ({ ids: new Set(kev.ids), fetchedAt: null, stale: kev.stale }),
  };
});

import { app } from "../app.js";
import { db, migrate } from "../db/index.js";
import { createApp, updateApp } from "../db/apps.js";
import { insertPeriodicScan } from "../db/periodic-scans.js";
import { createSession } from "../db/sessions.js";
import { createUser } from "../db/users.js";
import { RebuildBusyError } from "../deploy/rebuild.js";

const CSRF = "test-csrf-token";
let sessions: Record<string, string> = {};
let exploited = "";
let optedOut = "";
let clean = "";
let neverDeployed = "";

const counts = { critical: 0, high: 0, medium: 0, low: 0, unknown: 0 };
const kevFinding = { id: "CVE-2026-7777", severity: "LOW" as const, source: "image" as const };

function scan(appId: string, tag: string, findings = [kevFinding]) {
  insertPeriodicScan({ app_id: appId, image_tag: tag, scan_status: "warned", counts, findings });
}

beforeAll(async () => {
  migrate();
  const admin = await createUser("root", "pw-root-123456", "admin");
  const alice = await createUser("alice", "pw-alice-123456", "member");
  sessions = { root: createSession(admin.id).token, alice: createSession(alice.id).token };

  const a = createApp("alice");
  updateApp(a.id, { name: "Klantportaal", image_tag: "runway/a:1", status: "running" } as never);
  scan(a.id, "runway/a:1");
  exploited = a.id;

  const b = createApp("alice");
  updateApp(b.id, { name: "Oud prototype", image_tag: "runway/b:1", status: "running", auto_rebuild: 0 } as never);
  scan(b.id, "runway/b:1");
  optedOut = b.id;

  const c = createApp("alice");
  updateApp(c.id, { name: "Schone app", image_tag: "runway/c:1", status: "running" } as never);
  scan(c.id, "runway/c:1", []);
  clean = c.id;

  const d = createApp("alice");
  updateApp(d.id, { name: "Nog niet live" } as never);
  neverDeployed = d.id;
});

beforeEach(() => {
  startRebuildRun.mockReset();
  startRebuildRun.mockReturnValue(77);
  activeRebuildRunId.mockReset();
  activeRebuildRunId.mockReturnValue(null);
  kev.ids = new Set(["CVE-2026-7777"]);
  kev.stale = false;
  db.prepare(`DELETE FROM audit_log WHERE action IN ('rebuild_issues_started','rebuild_all_started')`).run();
});

function post(who: string | null, form: Record<string, string>, opts: { csrf?: boolean } = {}) {
  const csrf = opts.csrf ?? true;
  const cookie = [who ? `runway_session=${sessions[who]}` : "", csrf ? `runway_csrf=${CSRF}` : ""].filter(Boolean).join("; ");
  const body = new URLSearchParams({ ...(csrf ? { _csrf: CSRF } : {}), ...form });
  return app.request("/rebuild/run", {
    method: "POST",
    headers: { cookie, "content-type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });
}

const page = async (query = "") =>
  (await app.request(`/rebuild${query}`, { headers: { cookie: `runway_session=${sessions.root}` } })).text();
const loc = (r: Response) => r.headers.get("location");
const audit = (action: string) =>
  db.prepare(`SELECT username, detail FROM audit_log WHERE action = ?`).all(action) as Array<{ username: string; detail: string }>;

describe("GET /rebuild: what each button would do", () => {
  it("lists the apps with issues, with a reason each, and counts them on the button", async () => {
    const html = await page();
    expect(html).toContain("Rebuild 2 apps with issues");
    expect(html).toContain("Klantportaal");
    expect(html).toContain("Oud prototype");
    expect(html).toContain("1 actively exploited (KEV)");
    expect(html).toContain("Not rebuilt automatically");
    // the app with nothing wrong and the one that was never deployed are not in the issues list
    const issues = html.slice(html.indexOf('data-act="issues"'), html.indexOf('data-act="all"'));
    expect(issues).not.toContain("Schone app");
    expect(issues).not.toContain("Nog niet live");
  });

  it("counts every deployed app for 'all', and no never-deployed one", async () => {
    const html = await page();
    const from = html.indexOf('data-act="all"');
    const all = html.slice(from, html.indexOf("</details>", from));
    expect(all).toContain("Yes, rebuild all 3 apps");
    expect(all).toContain("That includes 1 that has no issues");
    expect(all).not.toContain("Nog niet live");
  });

  it("uses no confirm() dialog and keeps 'all' behind an in-page panel", async () => {
    const html = await page();
    expect(html).not.toContain("confirm(");
    expect(html).toMatch(/<details class="rr-all/);
    expect(html).not.toMatch(/<details class="rr-all[^>]* open/);
  });

  it("opens the panel when the server sends you there", async () => {
    expect(await page("?confirm=all")).toMatch(/<details class="rr-all[^>]* open/);
  });

  it("switches the main button off with a plain sentence when nothing needs a rebuild", async () => {
    kev.ids = new Set();
    const html = await page();
    expect(html).toMatch(/<button type="submit" disabled>Nothing needs a rebuild<\/button>/);
    expect(html).toContain("The weekly run would skip them all as well");
  });

  it("says so when the KEV list could not be refreshed", async () => {
    kev.stale = true;
    expect(await page()).toContain("could not be refreshed");
  });

  it("shows both buttons off while a run is busy", async () => {
    activeRebuildRunId.mockReturnValue(5);
    const html = await page();
    expect(html).toMatch(/<button type="submit" disabled>Run in progress/);
    expect(html).toMatch(/class="ghost" disabled>Run in progress/);
  });

  it("explains the outcome of a refused start", async () => {
    expect(await page("?none=1")).toContain("Nothing needs a rebuild: no app has");
    expect(await page("?none=all")).toContain("nothing to rebuild");
  });
});

describe("POST /rebuild/run, mode issues", () => {
  it("rebuilds exactly the listed apps with the same selection as the weekly run", async () => {
    const r = await post("root", { mode: "issues" });
    expect(loc(r)).toBe("/rebuild?started=1");
    expect(startRebuildRun).toHaveBeenCalledTimes(1);
    const opts = startRebuildRun.mock.calls[0]![0] as { trigger: string; appIds: string[]; onlyWithIssues: boolean; onlyVulnerable?: boolean };
    expect(opts.trigger).toBe("manual");
    expect(opts.onlyWithIssues).toBe(true);
    expect(opts.onlyVulnerable).toBeUndefined();
    expect([...opts.appIds].sort()).toEqual([exploited, optedOut].sort());
    expect(opts.appIds).not.toContain(clean);
    expect(opts.appIds).not.toContain(neverDeployed);
  });

  it("is the default when the mode is missing or unknown", async () => {
    expect(loc(await post("root", {}))).toBe("/rebuild?started=1");
    expect((startRebuildRun.mock.calls[0]![0] as { onlyWithIssues: boolean }).onlyWithIssues).toBe(true);
    startRebuildRun.mockClear();
    await post("root", { mode: "everything" });
    expect((startRebuildRun.mock.calls[0]![0] as { onlyWithIssues: boolean }).onlyWithIssues).toBe(true);
  });

  it("audits the mode and the number of apps", async () => {
    await post("root", { mode: "issues" });
    const rows = audit("rebuild_issues_started");
    expect(rows).toHaveLength(1);
    expect(rows[0]!.username).toBe("root");
    expect(rows[0]!.detail).toBe("run 77 (mode issues, 2 apps)");
  });

  it("starts nothing when no app has an issue, and says so", async () => {
    kev.ids = new Set();
    const r = await post("root", { mode: "issues" });
    expect(loc(r)).toBe("/rebuild?none=1");
    expect(startRebuildRun).not.toHaveBeenCalled();
    expect(audit("rebuild_issues_started")).toHaveLength(0);
  });

  it("does not let confirm=all turn it into a rebuild of everything", async () => {
    await post("root", { mode: "issues", confirm: "all" });
    expect((startRebuildRun.mock.calls[0]![0] as { appIds: string[] }).appIds).not.toContain(clean);
  });
});

describe("POST /rebuild/run, mode all", () => {
  it("sends you to the confirmation panel without starting anything", async () => {
    const r = await post("root", { mode: "all" });
    expect(loc(r)).toBe("/rebuild?confirm=all");
    expect(startRebuildRun).not.toHaveBeenCalled();
  });

  it("refuses a wrong confirmation value", async () => {
    expect(loc(await post("root", { mode: "all", confirm: "yes" }))).toBe("/rebuild?confirm=all");
    expect(startRebuildRun).not.toHaveBeenCalled();
  });

  it("starts a run over every app once confirmed, and audits mode and count", async () => {
    const r = await post("root", { mode: "all", confirm: "all" });
    expect(loc(r)).toBe("/rebuild?started=1");
    expect(startRebuildRun).toHaveBeenCalledTimes(1);
    const opts = startRebuildRun.mock.calls[0]![0] as Record<string, unknown>;
    expect(opts).toEqual({ trigger: "manual" });
    expect(audit("rebuild_all_started")[0]!.detail).toBe("run 77 (mode all, 3 apps)");
  });
});

describe("POST /rebuild/run: who may, and the one-run limit", () => {
  it("turns a member away, also the owner of the apps listed", async () => {
    const forms: Array<Record<string, string>> = [{ mode: "issues" }, { mode: "all", confirm: "all" }];
    for (const form of forms) {
      const r = await post("alice", form);
      expect(r.status).toBe(302);
      expect(loc(r)).toBe("/?forbidden=1");
    }
    expect(startRebuildRun).not.toHaveBeenCalled();
  });

  it("sends an anonymous visitor to the login", async () => {
    const r = await post(null, { mode: "issues" });
    expect(loc(r) ?? "").toMatch(/login/);
    expect(startRebuildRun).not.toHaveBeenCalled();
  });

  it("rejects a request without the CSRF token, in both modes", async () => {
    expect((await post("root", { mode: "issues" }, { csrf: false })).status).toBe(403);
    expect((await post("root", { mode: "all", confirm: "all" }, { csrf: false })).status).toBe(403);
    expect(startRebuildRun).not.toHaveBeenCalled();
  });

  it("answers 'busy' while a run is going, before anything else", async () => {
    activeRebuildRunId.mockReturnValue(5);
    expect(loc(await post("root", { mode: "issues" }))).toBe("/rebuild?busy=1");
    expect(loc(await post("root", { mode: "all", confirm: "all" }))).toBe("/rebuild?busy=1");
    expect(startRebuildRun).not.toHaveBeenCalled();
  });

  it("also answers 'busy' when the run slot is taken between the check and the start", async () => {
    startRebuildRun.mockImplementation(() => {
      throw new RebuildBusyError();
    });
    expect(loc(await post("root", { mode: "issues" }))).toBe("/rebuild?busy=1");
    expect(loc(await post("root", { mode: "all", confirm: "all" }))).toBe("/rebuild?busy=1");
    expect(audit("rebuild_issues_started")).toHaveLength(0);
    expect(audit("rebuild_all_started")).toHaveLength(0);
  });
});
