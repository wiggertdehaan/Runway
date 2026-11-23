/**
 * Hit buckets: the overview compares a 30-day period with the one before it,
 * so the table keeps 60 days. In-memory database.
 */
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { db, migrate } from "./index.js";
import { createApp } from "./apps.js";
import { bumpRequest, getBucketsBulk, hourKey, pruneOldBuckets } from "./activity.js";
import { RETENTION_HOURS } from "../deploy/activity-tailer.js";
import { HITS_HISTORY_HOURS } from "../overview/build.js";

const HOUR = 3_600_000;
let id = "";

beforeAll(() => migrate());
beforeEach(() => {
  db.exec("DELETE FROM app_request_buckets");
  db.exec("DELETE FROM apps");
  id = createApp().id;
});

describe("hit retention", () => {
  it("keeps 60 days plus a few hours, and the overview asks for exactly 60 days", () => {
    expect(RETENTION_HOURS).toBe(60 * 24 + 6);
    expect(HITS_HISTORY_HOURS).toBe(60 * 24);
    expect(RETENTION_HOURS).toBeGreaterThan(HITS_HISTORY_HOURS);
  });

  it("prunes a bucket of 61 days ago and keeps one of 59 days", () => {
    const now = Date.now();
    bumpRequest(id, new Date(now - 61 * 24 * HOUR));
    bumpRequest(id, new Date(now - 59 * 24 * HOUR));
    const removed = pruneOldBuckets(RETENTION_HOURS);
    expect(removed).toBe(1);
    const left = db.prepare("SELECT hour_at FROM app_request_buckets").all() as Array<{ hour_at: string }>;
    expect(left.map((r) => r.hour_at)).toEqual([hourKey(new Date(now - 59 * 24 * HOUR))]);
  });

  it("returns 60 days of hourly buckets, oldest first, with the 59-day-old hit in place", () => {
    const now = Date.now();
    bumpRequest(id, new Date(now - 59 * 24 * HOUR));
    bumpRequest(id, new Date(now));
    bumpRequest(id, new Date(now));
    const series = getBucketsBulk([id], HITS_HISTORY_HOURS).get(id)!;
    expect(series).toHaveLength(HITS_HISTORY_HOURS);
    expect(series[series.length - 1]).toBe(2);
    expect(series.reduce((a, b) => a + b, 0)).toBe(3);
    expect(series[1440 - 59 * 24 - 1]).toBe(1);
  });
});
