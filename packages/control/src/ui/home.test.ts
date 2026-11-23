import { describe, expect, it } from "vitest";
import { homeChips, needsAttention, renderChips } from "./home.js";
import type { StateCounts } from "./status.js";

const counts = (over: Partial<StateCounts> = {}): StateCounts => ({
  live: 0,
  building: 0,
  failed: 0,
  stopped: 0,
  offline: 0,
  ...over,
});

describe("needsAttention", () => {
  it("is true for failed and offline apps", () => {
    expect(needsAttention({ state: "failed", security: null })).toBe(true);
    expect(needsAttention({ state: "offline", security: null })).toBe(true);
  });
  it("is true for a live app with a warning or error security chip", () => {
    const chip = (tone: "ok" | "warn" | "err" | "neutral") => ({ tone, label: "x", detail: null, target: "scan" as const });
    expect(needsAttention({ state: "live", security: chip("warn") })).toBe(true);
    expect(needsAttention({ state: "live", security: chip("err") })).toBe(true);
    expect(needsAttention({ state: "live", security: chip("ok") })).toBe(false);
    expect(needsAttention({ state: "live", security: chip("neutral") })).toBe(false);
  });
  it("is false for a healthy live, building or stopped app", () => {
    expect(needsAttention({ state: "live", security: null })).toBe(false);
    expect(needsAttention({ state: "building", security: null })).toBe(false);
    expect(needsAttention({ state: "stopped", security: null })).toBe(false);
  });
});

describe("homeChips", () => {
  it("is empty without apps", () => {
    expect(homeChips(counts(), 0)).toEqual([]);
  });
  it("starts with All and leaves out states with no apps", () => {
    const chips = homeChips(counts({ live: 4, failed: 1 }), 0);
    expect(chips.map((c) => [c.key, c.count])).toEqual([
      ["all", 5],
      ["live", 4],
      ["failed", 1],
    ]);
  });
  it("adds Needs attention right after All, only when there is something", () => {
    const chips = homeChips(counts({ live: 3, offline: 1 }), 2);
    expect(chips.map((c) => c.key)).toEqual(["all", "attention", "live", "offline"]);
    expect(chips[1]).toMatchObject({ label: "Needs attention", count: 2 });
  });
  it("counts unconfigured apps in All only", () => {
    const chips = homeChips(counts({ live: 1 }), 0, 2);
    expect(chips[0]).toMatchObject({ key: "all", count: 3 });
    expect(chips.map((c) => c.key)).toEqual(["all", "live"]);
  });
  it("keeps a fixed order of states", () => {
    const chips = homeChips(counts({ offline: 1, live: 1, building: 1, stopped: 1, failed: 1 }), 0);
    expect(chips.map((c) => c.key)).toEqual(["all", "live", "building", "failed", "stopped", "offline"]);
  });
});

describe("renderChips", () => {
  it("renders nothing for no chips", () => {
    expect(renderChips([])).toBe("");
  });
  it("renders one button per chip with its key and count, All pressed", () => {
    const html = renderChips(homeChips(counts({ live: 2 }), 0));
    expect(html).toContain('data-chip="all" aria-pressed="true"');
    expect(html).toContain('data-chip="live" aria-pressed="false"');
    expect(html).toContain('<span class="chip-n">2</span>');
    expect(html).toContain('role="group"');
  });
});
