import { describe, expect, it } from "vitest";
import type { AtRiskApp } from "../routes/security-view.js";
import type { SecurityChip } from "./status.js";
import { findingDetail, navCount, renderSecurityPage, securityTiles, splitSecurity, type SecurityApp } from "./security-page.js";

const NOW = Date.parse("2026-11-23T08:00:00Z");
const H = 3_600_000;

const chip = (tone: SecurityChip["tone"], label = "x", detail: string | null = null): SecurityChip => ({
  tone,
  label,
  detail,
  target: "scan",
});

const kevApp = (over: Partial<AtRiskApp> = {}): AtRiskApp => ({
  id: "a",
  name: "a",
  owner: null,
  state: "grace",
  cves: ["CVE-2026-1000"],
  deadline: new Date(NOW + 30 * H).toISOString(),
  quarantinedAt: null,
  exemptUntil: null,
  ...over,
});

const app = (id: string, over: Partial<SecurityApp> = {}): SecurityApp => ({
  id,
  name: id,
  owner: null,
  kev: undefined,
  status: { security: null },
  hasImage: true,
  ...over,
});

describe("splitSecurity", () => {
  it("puts KEV apps in action, scan warnings in findings, the rest in clean", () => {
    const s = splitSecurity([
      app("kev", { kev: kevApp({ id: "kev" }) }),
      app("warn", { status: { security: chip("warn") } }),
      app("err", { status: { security: chip("err") } }),
      app("ok", { status: { security: chip("ok") } }),
      app("neutral", { status: { security: chip("neutral") } }),
      app("none"),
    ]);
    expect(s.action.map((a) => a.id)).toEqual(["kev"]);
    expect(s.findings.map((a) => a.id)).toEqual(["err", "warn"]);
    expect(s.clean.map((a) => a.id)).toEqual(["neutral", "none", "ok"]);
  });

  it("lists offline apps first, then the soonest deadline, unknown last", () => {
    const s = splitSecurity([
      app("late", { kev: kevApp({ id: "late", deadline: new Date(NOW + 90 * H).toISOString() }) }),
      app("unknown", { kev: kevApp({ id: "unknown", deadline: null }) }),
      app("soon", { kev: kevApp({ id: "soon", deadline: new Date(NOW + 5 * H).toISOString() }) }),
      app("down", {
        kev: kevApp({ id: "down", state: "quarantined", deadline: null, quarantinedAt: new Date(NOW - 48 * H).toISOString() }),
      }),
    ]);
    expect(s.action.map((a) => a.id)).toEqual(["down", "soon", "late", "unknown"]);
  });

  it("an app with a KEV term never also shows up under findings", () => {
    const s = splitSecurity([app("both", { kev: kevApp(), status: { security: chip("err") } })]);
    expect(s.action).toHaveLength(1);
    expect(s.findings).toHaveLength(0);
  });
});

describe("securityTiles", () => {
  it("counts offline, term, findings and clean, and colours only non-zero tiles", () => {
    const split = splitSecurity([
      app("a", { kev: kevApp({ state: "quarantined", quarantinedAt: new Date(NOW).toISOString() }) }),
      app("b", { kev: kevApp() }),
      app("c", { kev: kevApp() }),
      app("d", { status: { security: chip("warn") } }),
    ]);
    const t = Object.fromEntries(securityTiles(split).map((x) => [x.key, x]));
    expect(t.offline).toMatchObject({ n: 1, tone: "err" });
    expect(t.term).toMatchObject({ n: 2, tone: "warn" });
    expect(t.findings).toMatchObject({ n: 1, tone: "warn" });
    expect(t.clean).toMatchObject({ n: 0, tone: "none" });
  });
});

describe("navCount", () => {
  it("is empty for zero, negative and NaN", () => {
    expect(navCount(0)).toBe("");
    expect(navCount(-3)).toBe("");
    expect(navCount(Number.NaN)).toBe("");
  });
  it("shows the number, capped at 99+", () => {
    expect(navCount(1)).toBe("1");
    expect(navCount(99)).toBe("99");
    expect(navCount(100)).toBe("99+");
  });
});

describe("renderSecurityPage", () => {
  const base = { now: NOW, admin: false, kevStatusHtml: "<p>kev line</p>", termDays: 7 };

  it("says nothing needs action when no app is in a term", () => {
    const html = renderSecurityPage({ ...base, apps: [app("x", { status: { security: chip("ok") } })] });
    expect(html).toContain("Nothing needs action");
    expect(html).toContain("<p>kev line</p>");
  });

  it("explains the first-deploy case when there are no apps", () => {
    expect(renderSecurityPage({ ...base, apps: [] })).toContain("No apps yet");
  });

  it("shows the countdown, the CVE ids and a Rebuild button for an app in a term", () => {
    const html = renderSecurityPage({
      ...base,
      apps: [app("weekplanner", { kev: kevApp({ id: "weekplanner", name: "weekplanner" }) })],
    });
    expect(html).toContain("Goes offline in 1d 6h");
    expect(html).toContain("CVE-2026-1000");
    expect(html).toContain('action="/apps/weekplanner/rebuild"');
    expect(html).toContain("Term running");
  });

  it("leaves the Rebuild button out when the app has no built image", () => {
    const html = renderSecurityPage({ ...base, apps: [app("x", { hasImage: false, kev: kevApp({ id: "x" }) })] });
    expect(html).not.toContain("/rebuild");
    expect(html).toContain('href="/apps/x#quarantine"');
  });

  it("shows the owner name to admins only", () => {
    const apps = [app("x", { owner: "sanne", kev: kevApp({ id: "x" }) })];
    expect(renderSecurityPage({ ...base, admin: true, apps })).toContain("owner sanne");
    expect(renderSecurityPage({ ...base, admin: false, apps })).not.toContain("sanne");
  });

  it("escapes app names and finding text", () => {
    const html = renderSecurityPage({
      ...base,
      apps: [
        app("1", { name: '<img src=x onerror=alert(1)>', kev: kevApp({ id: "1" }) }),
        app("2", { name: "<b>y</b>", status: { security: chip("warn", "<i>z</i>", "<u>d</u>") } }),
      ],
    });
    expect(html).not.toContain("<img");
    expect(html).not.toContain("<b>y");
    expect(html).not.toContain("<i>z");
    expect(html).not.toContain("<u>d");
  });

  it("links findings to the scan section and clean apps to the scan section", () => {
    const html = renderSecurityPage({
      ...base,
      apps: [app("f", { status: { security: chip("warn", "2 issues") } }), app("c", { status: { security: chip("ok") } })],
    });
    expect(html).toContain('href="/apps/f#scan"');
    expect(html).toContain("2 issues");
    expect(html).toContain('class="sec-pill" href="/apps/c#scan"');
  });

  it("takes the term length from the setting, singular for one day", () => {
    expect(renderSecurityPage({ ...base, termDays: 1, apps: [] })).toContain("term of 1 day starts");
    expect(renderSecurityPage({ ...base, termDays: 14, apps: [] })).toContain("term of 14 days starts");
  });
});

describe("findingDetail", () => {
  it("spells out the '+N other' fragment", () => {
    expect(findingDetail({ detail: "+4 other" })).toBe("Plus 4 lower-severity findings.");
    expect(findingDetail({ detail: "+1 other" })).toBe("Plus 1 lower-severity finding.");
  });
  it("keeps other details as they are and explains a missing one", () => {
    expect(findingDetail({ detail: "Last deploy blocked" })).toBe("Last deploy blocked");
    expect(findingDetail({ detail: null })).toBe("Below the blocking threshold.");
  });
});
