import { describe, expect, it } from "vitest";
import type { AtRiskApp } from "../routes/security-view.js";
import { APP_STATES, appStatus, countStates, securityChip, summaryParts } from "./status.js";

const NOW = Date.parse("2026-11-23T10:00:00Z");
const HOUR = 3_600_000;
const iso = (ms: number) => new Date(ms).toISOString();

function kev(over: Partial<AtRiskApp> = {}): AtRiskApp {
  return {
    id: "a1",
    name: "weekplanner",
    owner: "sanne",
    state: "grace",
    cves: ["CVE-2026-1111"],
    deadline: iso(NOW + 3 * 24 * HOUR + 23 * HOUR),
    quarantinedAt: null,
    exemptUntil: null,
    ...over,
  };
}

const scan = (status: string, counts: Record<string, number> = {}) => JSON.stringify({ status, counts });
const st = (dbStatus: string, containerState?: string | null) =>
  appStatus({ dbStatus, containerState, now: NOW });

describe("appStatus: one word per app", () => {
  it("trusts the database when Docker has no opinion", () => {
    expect(st("running").state).toBe("live");
    expect(st("running", null).state).toBe("live");
    expect(st("running", "running").label).toBe("Live");
  });

  it("maps every pipeline step to Building and says which", () => {
    expect(st("building").state).toBe("building");
    expect(st("scanning").state).toBe("building");
    expect(st("starting").state).toBe("building");
    expect(st("scanning").reason).toContain("vulnerabilities");
  });

  it("lets an in-flight deploy win over the old container", () => {
    expect(st("building", "running").state).toBe("building");
    expect(st("starting", "exited").state).toBe("building");
  });

  it("calls a quarantined app Offline whatever Docker says", () => {
    expect(st("quarantined").state).toBe("offline");
    expect(st("quarantined", "running").state).toBe("offline");
    expect(st("quarantined").reason).toContain("actively exploited");
  });

  it("calls a failed deploy Failed", () => {
    expect(st("failed").state).toBe("failed");
    expect(st("failed", "running").state).toBe("failed");
  });

  it("turns a dying container into Failed with a precise label", () => {
    expect(st("running", "exited")).toMatchObject({ state: "failed", label: "Crashed" });
    expect(st("running", "dead").state).toBe("failed");
    expect(st("running", "restarting")).toMatchObject({ state: "failed", label: "Crash loop" });
    expect(st("running", "weird").state).toBe("failed");
  });

  it("calls stopped, paused and never-deployed apps Stopped", () => {
    expect(st("stopped").state).toBe("stopped");
    expect(st("running", "paused").state).toBe("stopped");
    expect(st("created")).toMatchObject({ state: "stopped", label: "Not deployed" });
  });

  it("never invents a sixth state for an unknown database status", () => {
    const s = st("mystery");
    expect(APP_STATES).toContain(s.state);
    expect(s.label).toBe("mystery");
  });

  it("always returns one of the five states", () => {
    for (const db of ["created", "building", "scanning", "starting", "running", "failed", "stopped", "quarantined", ""]) {
      for (const c of [undefined, null, "running", "exited", "restarting", "paused", "created", "dead"]) {
        expect(APP_STATES).toContain(st(db, c).state);
      }
    }
  });
});

describe("security chip", () => {
  it("is empty without a scan or a KEV term", () => {
    expect(securityChip({ now: NOW })).toBeNull();
    expect(securityChip({ scanSummary: "not json", now: NOW })).toBeNull();
    expect(securityChip({ scanSummary: "null", now: NOW })).toBeNull();
  });

  it("shows the countdown for an app in its term", () => {
    expect(securityChip({ kev: kev(), now: NOW })).toMatchObject({
      tone: "warn",
      label: "Offline in 3d 23h",
      detail: "CVE-2026-1111",
      target: "quarantine",
    });
  });

  it("turns red when less than a day is left", () => {
    const c = securityChip({ kev: kev({ deadline: iso(NOW + 2 * HOUR) }), now: NOW });
    expect(c?.tone).toBe("err");
    expect(c?.label).toBe("Offline in 2h");
  });

  it("honours an exemption that postpones the deadline", () => {
    const c = securityChip({
      kev: kev({ deadline: iso(NOW + 2 * HOUR), exemptUntil: iso(NOW + 5 * 24 * HOUR) }),
      now: NOW,
    });
    expect(c).toMatchObject({ tone: "warn", label: "Offline in 5d" });
  });

  it("says so when the deadline is unknown", () => {
    expect(securityChip({ kev: kev({ deadline: null }), now: NOW })?.label).toBe("Goes offline unless fixed");
  });

  it("names the exploited vulnerability for a quarantined app", () => {
    const c = securityChip({ kev: kev({ state: "quarantined", cves: ["CVE-1", "CVE-2"] }), now: NOW });
    expect(c).toMatchObject({ tone: "err", label: "Exploited vulnerability", detail: "CVE-1, CVE-2" });
  });

  it("puts the KEV term above a clean scan", () => {
    const c = securityChip({ kev: kev(), scanSummary: scan("passed"), now: NOW });
    expect(c?.target).toBe("quarantine");
  });

  it("summarises the last scan", () => {
    expect(securityChip({ scanSummary: scan("passed"), now: NOW })).toMatchObject({ tone: "ok", label: "Secure" });
    expect(securityChip({ scanSummary: scan("blocked", { critical: 1, high: 4 }), now: NOW })).toMatchObject({
      tone: "err",
      label: "1 critical, 4 high",
      detail: "Last deploy blocked",
    });
    expect(securityChip({ scanSummary: scan("warned", { high: 1, medium: 2 }), now: NOW })).toMatchObject({
      tone: "warn",
      label: "1 issue",
      detail: "+2 other",
    });
    expect(securityChip({ scanSummary: scan("warned", { critical: 1, high: 2 }), now: NOW })?.label).toBe("3 issues");
    expect(securityChip({ scanSummary: scan("warned", { low: 2, unknown: 1 }), now: NOW })).toMatchObject({
      tone: "neutral",
      label: "3 low",
    });
    expect(securityChip({ scanSummary: scan("skipped"), now: NOW })).toMatchObject({
      tone: "neutral",
      label: "Scan skipped",
    });
  });

  it("is carried on appStatus, independent of the state", () => {
    const s = appStatus({ dbStatus: "running", kev: kev(), now: NOW });
    expect(s.state).toBe("live");
    expect(s.security?.label).toBe("Offline in 3d 23h");
  });
});

describe("summary line", () => {
  it("counts per state and leaves empty states out in a fixed order", () => {
    const counts = countStates([
      { state: "live" },
      { state: "failed" },
      { state: "live" },
      { state: "stopped" },
    ]);
    expect(counts).toEqual({ live: 2, building: 0, failed: 1, stopped: 1, offline: 0 });
    expect(summaryParts(counts).map((p) => p.text)).toEqual(["4 apps", "2 live", "1 failed", "1 stopped"]);
  });

  it("is empty for no apps and singular for one", () => {
    expect(summaryParts(countStates([]))).toEqual([]);
    expect(summaryParts(countStates([{ state: "live" }])).map((p) => p.text)).toEqual(["1 app", "1 live"]);
  });
});
