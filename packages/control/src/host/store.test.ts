/**
 * Storage of host measurements: the migration, the 5-minute running mean, the
 * windows the page reads and the 60-day retention. In-memory database.
 */
import { DatabaseSync } from "node:sqlite";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { db, migrate } from "../db/index.js";
import { ensureHostTables } from "./schema.js";
import {
  BUCKET_MS,
  HOST_RETENTION_DAYS,
  bucketAverages,
  bucketStart,
  clearState,
  getState,
  getStateWithTime,
  latestSample,
  pruneHostMetrics,
  recordSample,
  sampleAtOrBefore,
  setState,
  windowAverage,
} from "./store.js";

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const T0 = Date.UTC(2026, 10, 23, 12, 0, 0); // on a bucket boundary

beforeAll(() => migrate());

beforeEach(() => {
  db.exec("DELETE FROM host_metrics");
  db.exec("DELETE FROM host_state");
});

describe("migration", () => {
  it("creates the tables, and running it again changes nothing", () => {
    const fresh = new DatabaseSync(":memory:");
    ensureHostTables(fresh);
    fresh.prepare("INSERT INTO host_metrics (kind, ts, value) VALUES ('cpu_pct', 1, 2)").run();
    ensureHostTables(fresh);
    ensureHostTables(fresh);
    expect(fresh.prepare("SELECT COUNT(*) AS n FROM host_metrics").get()).toEqual({ n: 1 });
    fresh.prepare("INSERT INTO host_state (key, value, updated_at) VALUES ('k', 'v', 1)").run();
    expect(fresh.prepare("SELECT value FROM host_state WHERE key = 'k'").get()).toEqual({ value: "v" });
  });

  it("is part of migrate() and idempotent there", () => {
    recordSample("cpu_pct", 10, T0);
    migrate();
    migrate();
    expect(latestSample("cpu_pct")).toEqual({ ts: T0, value: 10 });
  });

  it("works on a database that predates the host tables (an upgrade)", () => {
    const old = new DatabaseSync(":memory:");
    old.exec("CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT)");
    expect(() => ensureHostTables(old)).not.toThrow();
    const names = (old.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>).map(
      (r) => r.name
    );
    expect(names).toContain("host_metrics");
    expect(names).toContain("host_state");
  });
});

describe("recordSample: the 5-minute mean", () => {
  it("puts samples of one 5-minute window in one bucket and keeps their mean", () => {
    recordSample("cpu_pct", 10, T0 + 1_000);
    recordSample("cpu_pct", 20, T0 + 60_000);
    recordSample("cpu_pct", 60, T0 + 4 * 60_000);
    const rows = db.prepare("SELECT ts, value, n FROM host_metrics WHERE kind = 'cpu_pct'").all();
    expect(rows).toEqual([{ ts: T0, value: 30, n: 3 }]);
  });

  it("starts a new bucket every 5 minutes", () => {
    recordSample("cpu_pct", 10, T0);
    recordSample("cpu_pct", 50, T0 + BUCKET_MS);
    expect(db.prepare("SELECT COUNT(*) AS n FROM host_metrics").get()).toEqual({ n: 2 });
    expect(bucketStart(T0 + 299_999)).toBe(T0);
    expect(bucketStart(T0 + 300_000)).toBe(T0 + BUCKET_MS);
  });

  it("keeps kinds apart", () => {
    recordSample("cpu_pct", 10, T0);
    recordSample("mem_used_bytes", 5_000, T0);
    expect(latestSample("cpu_pct")!.value).toBe(10);
    expect(latestSample("mem_used_bytes")!.value).toBe(5_000);
  });

  it("survives a restart in the middle of a bucket: the mean is in the database, not in memory", () => {
    recordSample("cpu_pct", 10, T0);
    // (a restart forgets every in-memory accumulator; the next sample just continues the row)
    recordSample("cpu_pct", 30, T0 + 120_000);
    expect(latestSample("cpu_pct")!.value).toBe(20);
  });

  it("ignores values that are not numbers", () => {
    recordSample("cpu_pct", Number.NaN, T0);
    recordSample("cpu_pct", Number.POSITIVE_INFINITY, T0);
    expect(latestSample("cpu_pct")).toBeNull();
  });
});

describe("reading", () => {
  it("finds the newest sample, and the last one at or before a moment", () => {
    recordSample("disk_used_bytes", 100, T0 - 2 * DAY);
    recordSample("disk_used_bytes", 200, T0 - 1 * DAY);
    recordSample("disk_used_bytes", 300, T0);
    expect(latestSample("disk_used_bytes")!.value).toBe(300);
    expect(sampleAtOrBefore("disk_used_bytes", T0 - 1.5 * DAY)!.value).toBe(100);
    expect(sampleAtOrBefore("disk_used_bytes", T0 - 3 * DAY)).toBeNull();
    expect(latestSample("cpu_pct")).toBeNull();
  });

  it("averages a window, and says null for an empty one", () => {
    recordSample("cpu_pct", 10, T0 - 3 * HOUR);
    recordSample("cpu_pct", 30, T0 - 2 * HOUR);
    recordSample("cpu_pct", 90, T0 - 30 * HOUR);
    expect(windowAverage("cpu_pct", T0 - 24 * HOUR, T0)).toBe(20);
    expect(windowAverage("cpu_pct", T0 - 48 * HOUR, T0 - 24 * HOUR)).toBe(90);
    expect(windowAverage("cpu_pct", T0 - 100 * DAY, T0 - 90 * DAY)).toBeNull();
  });

  it("builds bucket averages oldest first, null where nothing was measured", () => {
    // 4 windows of 6 hours, the last one ends at T0
    recordSample("cpu_pct", 10, T0 - 23 * HOUR); // window 0
    recordSample("cpu_pct", 30, T0 - 22 * HOUR); // window 0
    recordSample("cpu_pct", 50, T0 - 5 * HOUR); // window 3
    expect(bucketAverages("cpu_pct", T0, 6 * HOUR, 4)).toEqual([20, null, null, 50]);
    expect(bucketAverages("mem_used_bytes", T0, 6 * HOUR, 4)).toEqual([null, null, null, null]);
  });

  it("does not count a sample from before the first window", () => {
    recordSample("cpu_pct", 99, T0 - 30 * HOUR);
    expect(bucketAverages("cpu_pct", T0, 6 * HOUR, 4)).toEqual([null, null, null, null]);
  });
});

describe("retention", () => {
  it("keeps 60 days and drops what is older", () => {
    expect(HOST_RETENTION_DAYS).toBe(60);
    recordSample("cpu_pct", 1, T0 - 61 * DAY);
    recordSample("cpu_pct", 2, T0 - 59 * DAY);
    recordSample("cpu_pct", 3, T0);
    expect(pruneHostMetrics(T0)).toBe(1);
    const left = (db.prepare("SELECT value FROM host_metrics ORDER BY ts").all() as Array<{ value: number }>).map((r) => r.value);
    expect(left).toEqual([2, 3]);
  });

  it("removes nothing when nothing is old", () => {
    recordSample("cpu_pct", 3, T0);
    expect(pruneHostMetrics(T0)).toBe(0);
  });
});

describe("state", () => {
  it("sets, overwrites, reads with its time and clears", () => {
    expect(getState("view:mem")).toBeNull();
    setState("view:mem", "host", 1_000);
    setState("view:mem", "container", 2_000);
    expect(getState("view:mem")).toBe("container");
    expect(getStateWithTime("view:mem")).toEqual({ value: "container", updatedAt: 2_000 });
    clearState("view:mem");
    expect(getState("view:mem")).toBeNull();
  });
});
