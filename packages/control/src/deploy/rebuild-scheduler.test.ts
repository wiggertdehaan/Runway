import { describe, it, expect } from "vitest";
import { localParts, parseTime, normalizeTime, isRebuildDue } from "./rebuild-scheduler.js";

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
