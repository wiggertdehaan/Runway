import { describe, expect, it } from "vitest";
import type { AtRiskApp } from "../routes/security-view.js";
import type { RebuildRun } from "../db/rebuild-runs.js";
import {
  agentPrompt,
  deployReason,
  mayRebuild,
  rebuildBlockedReason,
  rebuildLine,
  renderKevBlock,
  renderRebuildLine,
} from "./app-page.js";

const NOW = Date.parse("2026-11-23T10:00:00Z");
const kev = (over: Partial<AtRiskApp> = {}): AtRiskApp => ({
  id: "a1",
  name: "Shop",
  owner: "alice",
  state: "grace",
  cves: ["CVE-2026-0001"],
  deadline: new Date(NOW + 3 * 86_400_000 + 4 * 3_600_000).toISOString(),
  quarantinedAt: null,
  exemptUntil: null,
  ...over,
});

describe("mayRebuild", () => {
  it("lets an admin rebuild any app", () => {
    expect(mayRebuild({ username: "root", role: "admin" }, { created_by: "alice" })).toBe(true);
    expect(mayRebuild({ username: "root", role: "admin" }, { created_by: null })).toBe(true);
  });
  it("lets an owner rebuild their own app only", () => {
    expect(mayRebuild({ username: "alice", role: "member" }, { created_by: "alice" })).toBe(true);
    expect(mayRebuild({ username: "bob", role: "member" }, { created_by: "alice" })).toBe(false);
  });
  it("keeps apps without an owner admin-only", () => {
    expect(mayRebuild({ username: "alice", role: "member" }, { created_by: null })).toBe(false);
  });
});

describe("rebuildBlockedReason", () => {
  it("needs a built image", () => {
    expect(rebuildBlockedReason({ image_tag: null })).toMatch(/Deploy the app/);
    expect(rebuildBlockedReason({ image_tag: "runway/a1:1" })).toBeNull();
  });
});

describe("agentPrompt", () => {
  it("names the app and every CVE, and says what done means", () => {
    const p = agentPrompt({ id: "a1", name: "Shop" }, ["CVE-1", "CVE-2"]);
    expect(p).toContain('"Shop"');
    expect(p).toContain("CVE-1, CVE-2");
    expect(p).toMatch(/redeploy with Runway/);
  });
  it("copes with an empty CVE list", () => {
    expect(agentPrompt({ id: "a1", name: "Shop" }, [])).toContain("an actively exploited vulnerability");
  });
});

describe("deployReason", () => {
  it("says nothing for a success", () => {
    expect(deployReason({ status: "success", scan_summary: null, log: null })).toBeNull();
  });
  it("reads the counts for a blocked deploy", () => {
    const r = deployReason({ status: "blocked", scan_summary: JSON.stringify({ counts: { critical: 2, high: 5 } }), log: null });
    expect(r).toBe("Blocked by the scan: 2 critical, 5 high");
  });
  it("survives an unreadable summary", () => {
    expect(deployReason({ status: "blocked", scan_summary: "{oops", log: null })).toBe("Blocked by the scan");
  });
  it("shows the last log line of a failed deploy", () => {
    expect(deployReason({ status: "failed", scan_summary: null, log: "step 1\nstep 2 boom\n\n" })).toBe("Failed: step 2 boom");
  });
});

describe("rebuildLine", () => {
  const run = (id: number, appId: string, outcome: "rebuilt" | "failed", status: "done" | "running" = "done"): RebuildRun => ({
    id,
    trigger: "manual",
    status,
    started_at: "2026-11-23 09:00:00",
    finished_at: status === "done" ? "2026-11-23 09:05:00" : null,
    results: [{ app_id: appId, app_name: null, outcome, before: null, after: null }],
  });
  it("says running while a run covering this app is busy", () => {
    expect(rebuildLine([], "a1", { runId: 5, appIds: ["a1"] })).toEqual({ state: "running", scope: "app" });
    expect(rebuildLine([], "a1", { runId: 5, appIds: null })).toEqual({ state: "running", scope: "all" });
  });
  it("ignores a run busy on other apps", () => {
    expect(rebuildLine([], "a1", { runId: 5, appIds: ["zzz"] })).toEqual({ state: "none" });
  });
  it("shows the newest finished run that touched this app, not other apps' results", () => {
    const line = rebuildLine([run(9, "other", "failed"), run(8, "a1", "rebuilt"), run(7, "a1", "failed")], "a1", null);
    expect(line).toMatchObject({ state: "done", outcome: "rebuilt", runId: 8 });
  });
  it("does not show an older happy run when the newest run died before reaching the app", () => {
    const dead: RebuildRun = {
      id: 10,
      trigger: "manual",
      status: "done",
      started_at: "2026-11-23 10:00:00",
      finished_at: "2026-11-23 10:00:05",
      results: [{ app_id: "-", app_name: null, outcome: "failed", before: null, after: null, detail: "run crashed: /srv/secret/path" }],
    };
    const line = rebuildLine([dead, run(8, "a1", "rebuilt")], "a1", null);
    expect(line).toMatchObject({ state: "done", outcome: "failed", runId: 10 });
    expect(JSON.stringify(line)).not.toContain("/srv/secret/path");
  });
  it("renders a self-polling line only while running", () => {
    const f = (iso: string | null) => iso ?? "";
    expect(renderRebuildLine({ state: "running", scope: "app" }, "a1", f)).toContain('hx-trigger="every 5s"');
    expect(renderRebuildLine({ state: "done", outcome: "failed", detail: "x <b>", at: null, runId: 1 }, "a1", f)).not.toContain("hx-trigger");
    expect(renderRebuildLine({ state: "done", outcome: "failed", detail: "x <b>", at: null, runId: 1 }, "a1", f)).toContain("x &lt;b&gt;");
  });
});

describe("renderKevBlock", () => {
  const base = { app: { id: "a1", name: "Shop" }, now: NOW, canRebuild: true, rebuildDisabledReason: null, isAdmin: false };
  it("puts the countdown in the headline and shows the three steps", () => {
    const html = renderKevBlock({ ...base, kev: kev() });
    expect(html).toContain("Goes offline in 3d 4h");
    expect(html).toContain("Rebuild it.");
    expect(html).toContain("Ask your agent to fix it.");
    expect(html).toContain("Get more time.");
    expect(html).toContain('action="/apps/a1/rebuild"');
    expect(html).toContain("data-copy=");
  });
  it("tells an owner who may extend the term, and an admin where", () => {
    expect(renderKevBlock({ ...base, kev: kev() })).toContain("Only an admin can extend");
    expect(renderKevBlock({ ...base, isAdmin: true, kev: kev() })).toContain("Grant an exemption");
  });
  it("shows the reason instead of a button when a rebuild is not possible", () => {
    const html = renderKevBlock({ ...base, canRebuild: false, rebuildDisabledReason: "A rebuild is already running.", kev: kev() });
    expect(html).not.toContain('action="/apps/a1/rebuild"');
    expect(html).toContain("A rebuild is already running.");
  });
  it("says offline for a quarantined app", () => {
    const html = renderKevBlock({ ...base, kev: kev({ state: "quarantined", quarantinedAt: "2026-11-22T08:00:00Z", deadline: null }) });
    expect(html).toContain("Offline since");
    expect(html).toContain("taken offline");
  });
  it("escapes app names and CVE ids", () => {
    const html = renderKevBlock({ ...base, app: { id: "a1", name: '"><script>x</script>' }, kev: kev({ cves: ["<img>"] }) });
    expect(html).not.toContain("<script>x");
    expect(html).not.toContain("<img>");
  });
});

import { mayRescan, rescanBlockedReason } from "./app-page.js";

describe("mayRescan", () => {
  it("allows an admin, the owner, and nobody else", () => {
    expect(mayRescan({ username: "root", role: "admin" }, { created_by: "alice" })).toBe(true);
    expect(mayRescan({ username: "alice", role: "member" }, { created_by: "alice" })).toBe(true);
    expect(mayRescan({ username: "bob", role: "member" }, { created_by: "alice" })).toBe(false);
  });

  it("keeps an app without an owner admin-only", () => {
    expect(mayRescan({ username: "alice", role: "member" }, { created_by: null })).toBe(false);
    expect(mayRescan({ username: "root", role: "admin" }, { created_by: null })).toBe(true);
  });
});

describe("rescanBlockedReason", () => {
  it("needs an image and a running app", () => {
    expect(rescanBlockedReason({ image_tag: null, status: "running" })).toMatch(/Deploy the app once/);
    expect(rescanBlockedReason({ image_tag: "x:1", status: "stopped" })).toMatch(/running app/);
    expect(rescanBlockedReason({ image_tag: "x:1", status: "running" })).toBeNull();
  });
});

describe("renderKevBlock rescan button", () => {
  const base = {
    app: { id: "a1", name: "Shop" },
    kev: kev(),
    now: NOW,
    canRebuild: true,
    rebuildDisabledReason: null,
    isAdmin: false,
  };
  it("shows a rescan form only when the viewer may rescan", () => {
    expect(renderKevBlock({ ...base, canRescan: true })).toContain('action="/apps/a1/rescan"');
    expect(renderKevBlock({ ...base, canRescan: false })).not.toContain("/rescan");
    expect(renderKevBlock(base)).not.toContain("/rescan");
  });
});
