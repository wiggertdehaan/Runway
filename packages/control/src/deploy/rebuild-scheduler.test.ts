import { describe, it, expect } from "vitest";
import {
  localParts,
  parseTime,
  normalizeTime,
  isRebuildDue,
  nextScheduledRebuild,
  zonedToUtc,
  formatScheduled,
} from "./rebuild-scheduler.js";

const sun5 = { enabled: true, day: 0, time: "05:00" };

describe("localParts (Europe/Amsterdam)", () => {
  it("summer (CEST, UTC+2): 03:00Z is 05:00 Sunday", () => {
    const p = localParts(new Date("2026-07-05T03:00:00Z"));
    expect(p).toEqual({ date: "2026-07-05", weekday: 0, minutes: 300 });
  });
  it("winter (CET, UTC+1): 04:00Z is 05:00 Sunday", () => {
    const p = localParts(new Date("2026-11-22T04:00:00Z"));
    expect(p).toEqual({ date: "2026-11-22", weekday: 0, minutes: 300 });
  });
  it("crosses midnight into the next local day", () => {
    const p = localParts(new Date("2026-11-21T23:30:00Z"));
    expect(p.date).toBe("2026-11-22");
    expect(p.weekday).toBe(0);
  });
});

describe("parseTime / normalizeTime", () => {
  it("accepts HH:MM and H:MM", () => {
    expect(parseTime("05:00")).toBe(300);
    expect(parseTime("5:07")).toBe(307);
    expect(normalizeTime("5:07")).toBe("05:07");
  });
  it("rejects junk", () => {
    for (const v of ["", "24:00", "12:60", "noon", undefined]) expect(parseTime(v)).toBeNull();
  });
});

describe("isRebuildDue", () => {
  const at = (date: string, weekday: number, minutes: number) => ({ date, weekday, minutes });
  it("not before the time", () => {
    expect(isRebuildDue(sun5, at("2026-11-22", 0, 299), undefined)).toBe(false);
  });
  it("due at the time and later that day (missed-slot catch-up)", () => {
    expect(isRebuildDue(sun5, at("2026-11-22", 0, 300), undefined)).toBe(true);
    expect(isRebuildDue(sun5, at("2026-11-22", 0, 900), "2026-11-15")).toBe(true);
  });
  it("only once per day", () => {
    expect(isRebuildDue(sun5, at("2026-11-22", 0, 301), "2026-11-22")).toBe(false);
  });
  it("wrong weekday never fires", () => {
    expect(isRebuildDue(sun5, at("2026-11-23", 1, 600), undefined)).toBe(false);
  });
  it("disabled never fires", () => {
    expect(isRebuildDue({ ...sun5, enabled: false }, at("2026-11-22", 0, 600), undefined)).toBe(false);
  });
});

describe("zonedToUtc / formatScheduled", () => {
  it("winter: Sunday 05:00 in Amsterdam is 04:00Z", () => {
    expect(new Date(zonedToUtc("2026-11-29", 300)).toISOString()).toBe("2026-11-29T04:00:00.000Z");
  });
  it("summer: Sunday 05:00 in Amsterdam is 03:00Z", () => {
    expect(new Date(zonedToUtc("2026-06-07", 300)).toISOString()).toBe("2026-06-07T03:00:00.000Z");
  });
  it("is right on the days the clocks change", () => {
    // 2026-03-29 02:00 -> 03:00 (spring forward), 2026-10-25 03:00 -> 02:00 (fall back)
    expect(new Date(zonedToUtc("2026-03-29", 300)).toISOString()).toBe("2026-03-29T03:00:00.000Z");
    expect(new Date(zonedToUtc("2026-10-25", 300)).toISOString()).toBe("2026-10-25T04:00:00.000Z");
  });
  it("formats in the schedule's timezone", () => {
    expect(formatScheduled(Date.parse("2026-11-29T04:00:00Z"))).toBe("Sun 29 Nov 05:00");
    expect(formatScheduled(Date.parse("2026-06-07T03:00:00Z"))).toBe("Sun 7 Jun 05:00");
  });
});

describe("nextScheduledRebuild", () => {
  const d = (iso: string) => new Date(iso);
  it("is off when switched off", () => {
    expect(nextScheduledRebuild({ ...sun5, enabled: false }, d("2026-11-23T12:00:00Z"), undefined)).toEqual({ kind: "off" });
  });
  it("finds the coming Sunday from a Monday", () => {
    const n = nextScheduledRebuild(sun5, d("2026-11-23T12:00:00Z"), undefined);
    expect(n).toEqual({ kind: "at", at: Date.parse("2026-11-29T04:00:00Z") });
  });
  it("is later today on the right day before the time", () => {
    const n = nextScheduledRebuild(sun5, d("2026-11-29T03:00:00Z"), undefined);
    expect(n).toEqual({ kind: "at", at: Date.parse("2026-11-29T04:00:00Z") });
  });
  it("is due when the time has passed and today has not run yet", () => {
    expect(nextScheduledRebuild(sun5, d("2026-11-29T07:00:00Z"), "2026-11-22")).toEqual({ kind: "due" });
  });
  it("is next week once today has run", () => {
    const n = nextScheduledRebuild(sun5, d("2026-11-29T07:00:00Z"), "2026-11-29");
    expect(n).toEqual({ kind: "at", at: Date.parse("2026-12-06T04:00:00Z") });
  });
  it("counts days in Amsterdam time, not UTC (Saturday 23:30Z is already Sunday there)", () => {
    // 2026-11-28 23:30Z = Sunday 00:30 local, before 05:00: later the same Sunday
    const n = nextScheduledRebuild(sun5, d("2026-11-28T23:30:00Z"), undefined);
    expect(n).toEqual({ kind: "at", at: Date.parse("2026-11-29T04:00:00Z") });
  });
  it("crosses a clock change without skipping the week", () => {
    const n = nextScheduledRebuild(sun5, d("2026-10-24T12:00:00Z"), undefined);
    expect(n).toEqual({ kind: "at", at: Date.parse("2026-10-25T04:00:00Z") });
  });
});
