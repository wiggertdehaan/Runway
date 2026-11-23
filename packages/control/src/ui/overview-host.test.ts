/**
 * Markup of the server figures: the grey state, the "measured N ago" note, the
 * tooltip with the reason (escaped), the #server anchor on the first server
 * statistic only, and nothing of it for an owner.
 */
import { describe, expect, it } from "vitest";
import { buildOverview, type HostInput, type OverviewInput } from "../overview/build.js";
import { renderOverview } from "./overview.js";

const NOW = Date.UTC(2026, 10, 23, 12, 0, 0);
const MIN = 60_000;
const GB = 1e9;

const host = (over: Partial<HostInput> = {}): HostInput => ({
  procView: { view: "host", reason: null },
  diskView: { view: "host", reason: null },
  disk: { totalBytes: 200 * GB, usedBytes: 100 * GB, freeBytes: 100 * GB, pct: 50, measuredAt: NOW - MIN },
  cpu: { avg: 23, prevAvg: 20, series: [20, 23], measuredAt: NOW - MIN },
  mem: { avg: 8 * GB, prevAvg: 7 * GB, series: [7 * GB, 8 * GB], measuredAt: NOW - MIN },
  memTotalBytes: 16 * GB,
  data: {
    totalBytes: 41.2 * GB,
    startBytes: 40 * GB,
    series: [40 * GB, 41.2 * GB],
    parts: { images: 20 * GB, volumes: 10 * GB, containers: 1.2 * GB, buildcache: 10 * GB },
    note: null,
    measuredAt: NOW - 3 * MIN,
  },
  errors: {},
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
  nextRebuild: { kind: "off" },
  health: { total: 8, failed: [] },
  host: host(),
  ...over,
});

const render = (over: Partial<OverviewInput> = {}) =>
  renderOverview(buildOverview(input(over), NOW), { admin: over.viewer ? over.viewer.admin : true });

describe("the server figures in the page", () => {
  it("shows the Disk figure, linked to the server block, and the three server statistics", () => {
    const html = render();
    expect(html).toContain('href="#server"');
    expect(html).toContain(">Disk<");
    expect(html).toContain(">50%<"); // disk and memory
    for (const key of ["cpu", "mem", "data"]) expect(html).toContain(`data-stat="${key}"`);
    expect(html).toContain("23%");
    expect(html).toContain("41.2 GB");
    expect(html).toContain("+3 pts vs the previous 7 days");
    expect(html).toContain("+1.2 GB in the last 7 days");
  });

  it("puts the #server anchor on the first server statistic only", () => {
    const html = render();
    expect(html.match(/id="server"/g)).toHaveLength(1);
    expect(html).toMatch(/id="server"[^>]*data-stat="cpu"|data-stat="cpu"[^>]*id="server"/);
  });

  it("renders the grey 'Container view, not the host' state with its reason as an escaped tooltip", () => {
    const html = render({
      host: host({
        diskView: { view: "container", reason: `a "tmpfs" <b>volume</b>` },
        procView: { view: "container", reason: "MemTotal <= limit" },
      }),
    });
    expect(html).toContain("ov-grey");
    expect(html).toContain("Container view, not the host");
    expect(html).toContain("a &quot;tmpfs&quot; &lt;b&gt;volume&lt;/b&gt;");
    expect(html).not.toContain("<b>volume</b>");
    expect(html).toContain("MemTotal &lt;= limit");
  });

  it("renders 'No data yet' with the reason, escaped, and no empty sparkline", () => {
    const html = render({
      host: host({
        disk: null,
        cpu: { avg: null, prevAvg: null, series: [null, null], measuredAt: null },
        errors: { disk: "<script>alert(1)</script>", cpu: "EACCES" },
      }),
    });
    expect(html).toContain("No data yet");
    expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(html).not.toContain("<script>alert(1)</script>");
    const cpu = html.match(/<div class="ov-stat[^"]*" data-stat="cpu"[\s\S]*?<\/div>/)![0];
    expect(cpu).not.toContain("<svg");
  });

  it("says 'measured N min ago' for an old reading", () => {
    const html = render({ host: host({ cpu: { avg: 23, prevAvg: 20, series: [20, 23], measuredAt: NOW - 30 * MIN } }) });
    expect(html).toContain("measured 30 min ago");
  });

  it("renders the disk inbox item with its button", () => {
    const html = render({
      host: host({ disk: { totalBytes: 200 * GB, usedBytes: 190 * GB, freeBytes: 10 * GB, pct: 95, measuredAt: NOW - MIN } }),
    });
    expect(html).toContain("Server disk is 95% full");
    expect(html).toContain('href="/settings"');
    expect(html).toContain("Free space");
    expect(html).toContain("Needs you now");
  });
});

describe("what an owner is shown", () => {
  it("none of the server information, even when handed a host input", () => {
    const html = render({ viewer: { admin: false } });
    for (const leak of [">Disk<", "CPU", "Memory", "GB", "#server", 'id="server"', "Container view", "No data yet"]) {
      expect(html).not.toContain(leak);
    }
  });
});
