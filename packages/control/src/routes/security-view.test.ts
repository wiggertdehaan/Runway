import { describe, it, expect } from "vitest";
import {
  attentionWhen,
  fmtCountdown,
  offlineAt,
  sortAtRisk,
  renderSecurityAttention,
  renderRiskBadge,
  renderKevStatus,
  type AtRiskApp,
} from "./security-view.js";

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const NOW = Date.parse("2026-11-22T12:00:00Z");
const iso = (ms: number) => new Date(ms).toISOString();

const app = (over: Partial<AtRiskApp> = {}): AtRiskApp => ({
  id: "abc123",
  name: "Shop",
  owner: "wiggert",
  state: "grace",
  cves: ["CVE-2026-1"],
  deadline: iso(NOW + 3 * DAY),
  quarantinedAt: null,
  exemptUntil: null,
  ...over,
});

describe("fmtCountdown", () => {
  it("scales the unit to the time left", () => {
    expect(fmtCountdown(3 * DAY + 4 * HOUR + 59_000)).toBe("in 3d 4h");
    expect(fmtCountdown(2 * DAY)).toBe("in 2d");
    expect(fmtCountdown(5 * HOUR + 12 * 60_000)).toBe("in 5h 12m");
    expect(fmtCountdown(HOUR)).toBe("in 1h");
    expect(fmtCountdown(12 * 60_000)).toBe("in 12m");
  });
  it("does not show a negative or zero countdown", () => {
    expect(fmtCountdown(59_000)).toBe("any moment now");
    expect(fmtCountdown(-5 * HOUR)).toBe("any moment now");
  });
});

describe("offlineAt", () => {
  it("is the end of the grace term", () => {
    expect(offlineAt(app())).toBe(NOW + 3 * DAY);
  });
  it("is postponed by an exemption that outlasts the term", () => {
    expect(offlineAt(app({ exemptUntil: iso(NOW + 10 * DAY) }))).toBe(NOW + 10 * DAY);
  });
  it("is not brought forward by an exemption that ends before the term", () => {
    expect(offlineAt(app({ exemptUntil: iso(NOW + DAY) }))).toBe(NOW + 3 * DAY);
  });
  it("is null for an app that is already offline or has no known term", () => {
    expect(offlineAt(app({ state: "quarantined", quarantinedAt: iso(NOW) }))).toBeNull();
    expect(offlineAt(app({ deadline: null }))).toBeNull();
    expect(offlineAt(app({ deadline: "garbage" }))).toBeNull();
  });
});

describe("sortAtRisk", () => {
  it("puts offline apps first, then the soonest deadline, unknown last", () => {
    const sorted = sortAtRisk([
      app({ id: "late", name: "Late", deadline: iso(NOW + 6 * DAY) }),
      app({ id: "unknown", name: "Unknown", deadline: null }),
      app({ id: "down", name: "Down", state: "quarantined", quarantinedAt: iso(NOW - HOUR) }),
      app({ id: "soon", name: "Soon", deadline: iso(NOW + 2 * HOUR) }),
      app({ id: "exempt", name: "Exempt", deadline: iso(NOW + HOUR), exemptUntil: iso(NOW + 4 * DAY) }),
    ]);
    expect(sorted.map((a) => a.id)).toEqual(["down", "soon", "exempt", "late", "unknown"]);
  });
  it("does not change the list it was given", () => {
    const input = [app({ id: "b", deadline: iso(NOW + 2 * DAY) }), app({ id: "a", deadline: iso(NOW + DAY) })];
    sortAtRisk(input);
    expect(input.map((a) => a.id)).toEqual(["b", "a"]);
  });
});

describe("attentionWhen", () => {
  it("leads with the countdown and shows the exact moment", () => {
    expect(attentionWhen(app(), NOW)).toEqual({
      headline: "Goes offline in 3d",
      tone: "warn",
      detail: "2026-11-25 12:00 UTC",
    });
  });
  it("turns urgent on the last day", () => {
    expect(attentionWhen(app({ deadline: iso(NOW + 5 * HOUR) }), NOW).tone).toBe("err");
  });
  it("says offline since when quarantined", () => {
    const w = attentionWhen(app({ state: "quarantined", quarantinedAt: iso(NOW - HOUR) }), NOW);
    expect(w.headline).toBe("Offline since 2026-11-22 11:00 UTC");
    expect(w.tone).toBe("err");
  });
  it("uses the end of an active exemption", () => {
    const w = attentionWhen(app({ deadline: iso(NOW - DAY), exemptUntil: iso(NOW + 2 * DAY) }), NOW);
    expect(w.headline).toBe("Goes offline in 2d");
    expect(w.detail).toBe("Exemption until 2026-11-24 12:00 UTC");
  });
});

describe("renderSecurityAttention", () => {
  it("renders nothing when no app is at risk", () => {
    expect(renderSecurityAttention([], NOW)).toBe("");
  });
  it("puts the countdown, the CVEs and a link to the app first", () => {
    const html = renderSecurityAttention([app()], NOW);
    expect(html).toContain("1 app needs attention");
    expect(html).toContain("Goes offline in 3d");
    expect(html).toContain("2026-11-25 12:00 UTC");
    expect(html).toContain("CVE-2026-1");
    expect(html).toContain('href="/apps/abc123#quarantine"');
    expect(html).toContain("1 will go offline if nothing is done");
  });
  it("keeps the policy text behind a disclosure, after the rows", () => {
    const html = renderSecurityAttention([app()], NOW);
    expect(html.indexOf("attn-list")).toBeLessThan(html.indexOf("<details"));
    expect(html).toContain("What happens next?");
  });
  it("offers Rebuild to everybody who sees a row, and the owner name only to an admin", () => {
    const admin = renderSecurityAttention([app()], NOW, true);
    expect(admin).toContain('action="/apps/abc123/rebuild"');
    expect(admin).toContain("owner wiggert");
    expect(admin).toContain("A rebuild or a new deploy");
    const owner = renderSecurityAttention([app()], NOW, false);
    expect(owner).toContain('action="/apps/abc123/rebuild"');
    expect(owner).not.toContain("owner wiggert");
    expect(owner).toContain("your agent can do the second");
  });
  it("counts offline and pending apps separately and lists offline first", () => {
    const html = renderSecurityAttention(
      [app({ id: "p", name: "Pending" }), app({ id: "d", name: "Down", state: "quarantined", quarantinedAt: iso(NOW - HOUR) })],
      NOW
    );
    expect(html).toContain("2 apps need attention");
    expect(html).toContain("1 offline, 1 will go offline if nothing is done");
    expect(html).toContain("Offline since 2026-11-22 11:00 UTC");
    expect(html.indexOf("Down")).toBeLessThan(html.indexOf("Pending"));
  });
  it("marks the last day as urgent", () => {
    expect(renderSecurityAttention([app({ deadline: iso(NOW + 5 * HOUR) })], NOW)).toContain(
      "attn-err\">Goes offline in 5h"
    );
    expect(renderSecurityAttention([app()], NOW)).toContain("attn-warn\">Goes offline in 3d");
  });
  it("shows an active exemption and the postponed moment", () => {
    const html = renderSecurityAttention([app({ deadline: iso(NOW - DAY), exemptUntil: iso(NOW + 2 * DAY) })], NOW);
    expect(html).toContain("Goes offline in 2d");
    expect(html).toContain("Exemption until 2026-11-24 12:00 UTC");
  });
  it("escapes app names, owners and CVE text", () => {
    const html = renderSecurityAttention([app({ name: "<script>x</script>", owner: 'a"b', cves: ["<b>"] })], NOW, true);
    expect(html).not.toContain("<script>x");
    expect(html).toContain("&lt;script&gt;x");
    expect(html).toContain("a&quot;b");
    expect(html).toContain("&lt;b&gt;");
  });
});

describe("renderRiskBadge", () => {
  it("is empty for apps that are fine or already shown as quarantined", () => {
    expect(renderRiskBadge(undefined, NOW)).toBe("");
    expect(renderRiskBadge(app({ state: "quarantined" }), NOW)).toBe("");
  });
  it("counts down, and turns red on the last day", () => {
    expect(renderRiskBadge(app(), NOW)).toContain("badge-building");
    expect(renderRiskBadge(app(), NOW)).toContain(">offline in 3d<");
    expect(renderRiskBadge(app({ deadline: iso(NOW + 2 * HOUR) }), NOW)).toContain("badge-quarantined");
  });
});

describe("renderKevStatus", () => {
  const fresh = { fetchedAt: iso(NOW - 3 * HOUR), count: 1790 };
  it("reports a working check with list age, coverage and outcome", () => {
    const html = renderKevStatus(fresh, { running: 20, scanned: 20 }, 0, NOW, true);
    expect(html).toContain("Exploited-vulnerability check active");
    expect(html).toContain("KEV list of 2026-11-22 09:00 UTC (1790 CVEs)");
    expect(html).toContain("20 running apps scanned");
    expect(html).toContain("none at risk");
    expect(html).toContain("var(--status-success)");
  });
  it("says loudly that the check is off when there is no list", () => {
    const html = renderKevStatus(null, { running: 20, scanned: 20 }, 0, NOW, true);
    expect(html).toContain("Exploited-vulnerability check is off");
    expect(html).toContain("no app is being checked");
    expect(html).not.toContain("none at risk");
    expect(html).toContain("[kev]");
  });
  it("keeps the log hint for admins only", () => {
    expect(renderKevStatus(null, { running: 1, scanned: 1 }, 0, NOW, false)).not.toContain("[kev]");
  });
  it("warns when the list is older than two days", () => {
    const html = renderKevStatus({ fetchedAt: iso(NOW - 5 * DAY), count: 1790 }, { running: 2, scanned: 2 }, 0, NOW, false);
    expect(html).toContain("running on an old list");
    expect(html).toContain("5 days old");
    expect(html).not.toContain("none at risk");
  });
  it("treats an unreadable fetch time as no list", () => {
    expect(renderKevStatus({ fetchedAt: "nope", count: 3 }, { running: 1, scanned: 1 }, 0, NOW, false)).toContain(
      "check is off"
    );
  });
  it("flags apps without a scan and apps needing attention", () => {
    const html = renderKevStatus(fresh, { running: 20, scanned: 17 }, 2, NOW, false);
    expect(html).toContain("17 of 20 running apps scanned, 3 not yet");
    expect(html).toContain("2 need attention");
    expect(html).not.toContain("var(--status-success)");
  });
  it("leaves coverage out when nothing is running", () => {
    const html = renderKevStatus(fresh, { running: 0, scanned: 0 }, 0, NOW, false);
    expect(html).not.toContain("scanned");
    expect(html).toContain("none at risk");
  });
});
