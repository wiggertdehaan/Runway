/**
 * The overview markup: escaping, the weekly-rebuild sentence, the period
 * switch and what only an administrator is shown. Pure strings.
 */
import { describe, expect, it } from "vitest";
import { buildOverview, type OverviewApp, type OverviewInput } from "../overview/build.js";
import { nextRebuildLine, renderOverview } from "./overview.js";

const NOW = Date.UTC(2026, 10, 23, 12, 0, 0);
const DAY = 86_400_000;

const app = (id: string, name: string | null, over: Partial<OverviewApp> = {}): OverviewApp => ({
  id,
  name,
  createdAt: NOW - 90 * DAY,
  configured: true,
  state: "live",
  reason: null,
  ownerless: false,
  ...over,
});

const input = (over: Partial<OverviewInput> = {}): OverviewInput => ({
  viewer: { admin: true },
  apps: [],
  kev: [],
  events: [],
  hits: new Map(),
  tokens: [],
  exemptions: [],
  nextRebuild: { kind: "at", at: NOW + 6 * DAY, text: "Sun 29 Nov 05:00" },
  health: { total: 8, failed: [] },
  ...over,
});

describe("nextRebuildLine", () => {
  it("says 'apps with issues', never 'all apps'", () => {
    const lines = [
      nextRebuildLine({ kind: "at", at: 1, text: "Sun 29 Nov 05:00" }),
      nextRebuildLine({ kind: "due" }),
      nextRebuildLine({ kind: "off" }),
    ];
    expect(lines[0]).toBe("Next rebuild of apps with issues: Sun 29 Nov 05:00 (Europe/Amsterdam).");
    for (const l of lines) {
      expect(l).toContain("apps with issues");
      expect(l).not.toMatch(/all apps/i);
    }
  });
});

describe("renderOverview", () => {
  it("renders the calm state with the cijferrij, the rebuild time and the statistics", () => {
    const html = renderOverview(buildOverview(input({ apps: [app("a", "alpha")] }), NOW), { admin: true });
    expect(html).toContain("Everything is fine");
    expect(html).toContain("ov-head calm");
    expect(html).toContain("Next rebuild of apps with issues: Sun 29 Nov 05:00");
    expect(html).toContain('href="/audit"');
    expect(html).toContain("Recent activity");
    expect(html).not.toContain("Needs you now");
    for (const label of ["Apps live", "Down", "KEV risk", "Health"]) expect(html).toContain(`>${label}<`);
    expect(html).toContain("Last 7 days");
    expect(html).toContain("<polyline");
  });

  it("shows no 'Recent activity' link to an owner (the audit page is admin-only)", () => {
    const html = renderOverview(buildOverview(input({ viewer: { admin: false }, health: null }), NOW), { admin: false });
    expect(html).not.toContain("Recent activity");
    expect(html).not.toContain("/audit");
    expect(html).not.toContain(">Health<");
    expect(html).toContain(">Expiring<");
  });

  it("escapes app names and reasons everywhere", () => {
    const evil = `<img src=x onerror=alert(1)>"&'`;
    const html = renderOverview(
      buildOverview(
        input({
          apps: [app("x1", evil, { state: "failed", reason: evil })],
          hits: new Map([["x1", new Array(2880).fill(5)]]),
        }),
        NOW
      ),
      { admin: true }
    );
    expect(html).not.toContain("<img");
    expect(html).toContain("&lt;img src=x onerror=alert(1)&gt;");
  });

  it("groups the inbox, one button per row, and counts beyond the cap", () => {
    const html = renderOverview(
      buildOverview(
        input({
          apps: [app("d", "down-app", { state: "failed" })],
          tokens: [{ kind: "user", expiresAt: NOW + 2 * DAY }],
          events: [{ appId: "d", ts: NOW - 3600_000, code: "major_available" }],
        }),
        NOW
      ),
      { admin: true }
    );
    expect(html).toContain("Needs you now");
    expect(html).toContain("This week");
    expect(html).toContain("For your information");
    expect((html.match(/<li class="ov-item/g) ?? []).length).toBe(3);
    expect((html.match(/class="btn-link ghost"/g) ?? []).length).toBe(3);
    expect(html).toContain('href="/apps/d"');
  });

  it("words a first-time number as 'none in the previous period', not as a difference", () => {
    const html = renderOverview(
      buildOverview(input({ apps: [app("n", "fresh", { createdAt: NOW - DAY })] }), NOW, "7d"),
      { admin: true }
    );
    expect(html).toContain("+1, none in the previous 7 days");
    expect(html).not.toContain("none before");
  });

  it("marks the chosen period and links the others", () => {
    const html = renderOverview(buildOverview(input(), NOW, "30d"), { admin: true });
    expect(html).toContain('<a href="/overview?period=30d" aria-current="true">30 d</a>');
    expect(html).toContain('<a href="/overview?period=24h" aria-current="false">24 h</a>');
    expect(html).toContain("Last 30 days");
    expect(html).toContain("vs the previous 30 days");
  });

  it("names a failing server component without calling the page calm", () => {
    const html = renderOverview(buildOverview(input({ health: { total: 8, failed: ["Docker"] } }), NOW), { admin: true });
    expect(html).not.toContain("Everything is fine");
    expect(html).toContain("Your apps are fine");
    expect(html).toContain('href="/health"');
  });

  it("lists the top three apps by hits, linked and escaped", () => {
    const hits = new Map(
      ["a", "b", "c", "d"].map((id, i) => [id, new Array(2880).fill(i + 1)] as [string, number[]])
    );
    const apps = ["a", "b", "c", "d"].map((id) => app(id, id === "d" ? "<top>" : id));
    const html = renderOverview(buildOverview(input({ apps, hits }), NOW, "24h"), { admin: true });
    const top = html.match(/<ul class="ov-top3">[\s\S]*?<\/ul>/)![0];
    expect((top.match(/<li>/g) ?? []).length).toBe(3);
    expect(top).toContain("&lt;top&gt;");
    expect(top).not.toContain(">a<");
  });
});
