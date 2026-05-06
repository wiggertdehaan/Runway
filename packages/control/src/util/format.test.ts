import { describe, it, expect } from "vitest";
import {
  formatActivity,
  formatBytes,
  formatDuration,
  formatRelative,
} from "./format.js";

describe("formatBytes", () => {
  it("returns '—' for null/undefined/negative", () => {
    expect(formatBytes(null)).toBe("—");
    expect(formatBytes(undefined)).toBe("—");
    expect(formatBytes(-1)).toBe("—");
  });

  it("uses B for sub-KB values", () => {
    expect(formatBytes(0)).toBe("0 B");
    expect(formatBytes(1023)).toBe("1023 B");
  });

  it("scales up through KB/MB/GB/TB", () => {
    expect(formatBytes(1024)).toBe("1.00 KB");
    expect(formatBytes(1024 * 1024)).toBe("1.00 MB");
    expect(formatBytes(1024 ** 3)).toBe("1.00 GB");
    expect(formatBytes(1024 ** 4)).toBe("1.00 TB");
  });

  it("trims precision as the number gets larger", () => {
    expect(formatBytes(15 * 1024)).toBe("15.0 KB");
    expect(formatBytes(150 * 1024)).toBe("150 KB");
  });

  it("caps at TB even for huge values", () => {
    expect(formatBytes(1024 ** 5)).toMatch(/TB$/);
  });
});

describe("formatDuration", () => {
  it("returns '—' for negative or non-finite", () => {
    expect(formatDuration(-1)).toBe("—");
    expect(formatDuration(Number.NaN)).toBe("—");
    expect(formatDuration(Number.POSITIVE_INFINITY)).toBe("—");
  });

  it("formats sub-minute durations as Ns", () => {
    expect(formatDuration(0)).toBe("0s");
    expect(formatDuration(59_000)).toBe("59s");
  });

  it("formats minutes/seconds", () => {
    expect(formatDuration(60_000)).toBe("1m 0s");
    expect(formatDuration(125_000)).toBe("2m 5s");
  });

  it("formats hours/minutes", () => {
    expect(formatDuration(3_600_000)).toBe("1h 0m");
    expect(formatDuration(3_600_000 + 30 * 60_000)).toBe("1h 30m");
  });

  it("formats days/hours", () => {
    const day = 24 * 3_600_000;
    expect(formatDuration(day)).toBe("1d 0h");
    expect(formatDuration(day + 5 * 3_600_000)).toBe("1d 5h");
  });
});

describe("formatRelative", () => {
  const now = Date.parse("2026-05-06T12:00:00Z");

  it("returns '—' for nullish or unparseable", () => {
    expect(formatRelative(null, now)).toBe("—");
    expect(formatRelative(undefined, now)).toBe("—");
    expect(formatRelative("not a date", now)).toBe("—");
  });

  it("returns 'just now' for future timestamps (clock skew safety)", () => {
    expect(formatRelative("2026-05-06T12:00:30Z", now)).toBe("just now");
  });

  it("renders elapsed time when in the past", () => {
    expect(formatRelative("2026-05-06T11:59:00Z", now)).toBe("1m 0s ago");
    expect(formatRelative("2026-05-05T12:00:00Z", now)).toBe("1d 0h ago");
  });
});

describe("formatActivity", () => {
  const now = Date.parse("2026-05-06T12:00:00Z");

  it("reports no-traffic when absent or unparseable", () => {
    expect(formatActivity(null, now)).toEqual({
      label: "No traffic yet",
      tone: "none",
    });
    expect(formatActivity("garbage", now)).toEqual({
      label: "No traffic yet",
      tone: "none",
    });
  });

  it("active for last minute", () => {
    expect(formatActivity("2026-05-06T11:59:30Z", now)).toEqual({
      label: "Active just now",
      tone: "active",
    });
  });

  it("active with minute precision in last hour", () => {
    expect(formatActivity("2026-05-06T11:30:00Z", now)).toEqual({
      label: "Active 30m ago",
      tone: "active",
    });
  });

  it("recent in last 24h", () => {
    expect(formatActivity("2026-05-06T08:00:00Z", now)).toEqual({
      label: "Active 4h ago",
      tone: "recent",
    });
  });

  it("idle for sub-week gaps", () => {
    expect(formatActivity("2026-05-03T12:00:00Z", now)).toEqual({
      label: "Idle 3d",
      tone: "idle",
    });
  });

  it("caps at 7d+ for older traffic", () => {
    expect(formatActivity("2026-04-01T12:00:00Z", now)).toEqual({
      label: "Idle 7d+",
      tone: "idle",
    });
  });
});
