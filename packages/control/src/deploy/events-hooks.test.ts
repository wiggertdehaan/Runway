/**
 * Events are written where the outcome is already known: a recorded deploy, the
 * quarantine tick (start, countdown, resolution, exemption ends) and the health
 * watcher. In-memory database; docker and the network are not involved.
 */
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { db, migrate } from "../db/index.js";
import { createApp, updateApp, getApp } from "../db/apps.js";
import { recordDeploy } from "../db/deploys.js";
import { setExemption } from "../db/quarantine.js";
import { setSetting } from "../db/settings.js";
import { insertPeriodicScan } from "../db/periodic-scans.js";
import { evaluateAppQuarantine, emitCountdown, emitExemptionEvents } from "./quarantine.js";
import { healthWatchTick, observedState, resetHealthWatch } from "./health-watch.js";
import { listEvents } from "../db/events.js";
import { HEALTH_MIN_GAP_MS } from "../util/events.js";

const DAY = 86_400_000;
const quiet = { log() {}, warn() {}, error() {} } as unknown as Console;
let id = "";

beforeAll(() => migrate());

beforeEach(() => {
  db.exec("DELETE FROM app_events");
  db.exec("DELETE FROM event_meta");
  db.exec("DELETE FROM app_quarantine");
  db.exec("DELETE FROM quarantine_exemptions");
  db.exec("DELETE FROM app_periodic_scans");
  db.exec("DELETE FROM apps");
  setSetting("quarantine_term_days", "7");
  id = createApp().id;
  updateApp(id, { name: "shop", runtime: "node", image_tag: "runway/shop:1", status: "running" } as never);
  resetHealthWatch();
});

const codes = (appId = id) =>
  (db.prepare("SELECT code FROM app_events WHERE app_id = ? ORDER BY id").all(appId) as Array<{ code: string }>).map((r) => r.code);

describe("deploys", () => {
  it("a recorded deploy becomes one event each, by status", () => {
    recordDeploy(id, "t1", "success", "log");
    recordDeploy(id, "t2", "blocked", { log: "x" });
    recordDeploy(id, "t3", "unhealthy", { log: "x" });
    recordDeploy(id, "t4", "failed", { log: "x" });
    recordDeploy(id, "t1", "success", { log: "Rolled back", rollback: true });
    expect(codes()).toEqual([
      "deploy_succeeded",
      "deploy_failed:scan_blocked",
      "deploy_failed:unhealthy",
      "deploy_failed:build",
      "deploy_rolled_back",
    ]);
  });

  it("carries the deploy id and nothing of the log", () => {
    const d = recordDeploy(id, "t1", "unhealthy", { log: "TOKEN=abc123 stack trace" });
    const row = db.prepare("SELECT detail FROM app_events WHERE app_id = ?").get(id) as { detail: string };
    expect(JSON.parse(row.detail)).toEqual({ facts: { deploy_id: d.id } });
    expect(row.detail).not.toContain("abc123");
  });

  it("the deploys inside a rebuild stay quiet (the rebuild reports itself)", () => {
    recordDeploy(id, "t1", "success", { log: "x", silentEvent: true });
    recordDeploy(id, "t2", "blocked", { log: "x", silentEvent: true });
    expect(codes()).toEqual([]);
  });

  it("an event that cannot be written never breaks the deploy record", () => {
    db.exec("ALTER TABLE app_events RENAME TO app_events_gone");
    try {
      expect(() => recordDeploy(id, "t1", "success", "log")).not.toThrow();
      const n = db.prepare("SELECT COUNT(*) AS n FROM deploys WHERE app_id = ?").get(id) as { n: number };
      expect(n.n).toBe(1);
    } finally {
      db.exec("ALTER TABLE app_events_gone RENAME TO app_events");
    }
  });
});

describe("KEV: start, countdown, resolution", () => {
  const kev = new Set(["CVE-2024-0001"]);
  const scan = () =>
    insertPeriodicScan({
      app_id: id,
      image_tag: "runway/shop:1",
      scan_status: "warned",
      counts: { critical: 1, high: 0, medium: 0, low: 0, unknown: 0 },
      findings: [{ id: "CVE-2024-0001", severity: "CRITICAL", source: "image", pkg: "openssl" } as never],
    });

  it("announces the start with the CVE and the deadline, then 3 days and 1 day once each", async () => {
    scan();
    const t0 = Date.UTC(2026, 10, 23, 8);
    await evaluateAppQuarantine(getApp(id)!, kev, false, quiet, t0);
    expect(codes()).toEqual(["kev_grace_started"]);
    const first = listEvents({ since: 0, limit: 10, audience: { all: true } }).events[0]!;
    const detail = JSON.parse((db.prepare("SELECT detail FROM app_events WHERE id = ?").get(Number(parseInt(first.cursor.slice(3), 36))) as { detail: string }).detail);
    expect(detail.facts.cves).toEqual(["CVE-2024-0001"]);
    expect(Date.parse(detail.facts.deadline)).toBe(t0 + 7 * DAY);

    // nothing new while there is plenty of time
    await evaluateAppQuarantine(getApp(id)!, kev, false, quiet, t0 + 2 * DAY);
    expect(codes()).toEqual(["kev_grace_started"]);

    // 3 days left, asked many times: once
    for (let i = 0; i < 5; i++) await evaluateAppQuarantine(getApp(id)!, kev, false, quiet, t0 + 4.5 * DAY + i * 60_000);
    expect(codes()).toEqual(["kev_grace_started", "kev_deadline_3d"]);

    // 1 day left: once
    for (let i = 0; i < 5; i++) await evaluateAppQuarantine(getApp(id)!, kev, false, quiet, t0 + 6.5 * DAY + i * 60_000);
    expect(codes()).toEqual(["kev_grace_started", "kev_deadline_3d", "kev_deadline_1d"]);
  });

  it("an app first noticed late gets the tightest threshold only", () => {
    const t0 = Date.UTC(2026, 10, 23);
    emitCountdown(id, { kev_first_seen: { "CVE-2024-0001": new Date(t0 - 6.8 * DAY).toISOString() } }, 7 * DAY, t0);
    expect(codes()).toEqual(["kev_deadline_1d"]);
  });

  it("a new deadline (a new CVE with its own clock) gets its own countdown", () => {
    const t0 = Date.UTC(2026, 10, 23);
    const row = (first: number) => ({ kev_first_seen: { "CVE-2024-0001": new Date(first).toISOString() } });
    emitCountdown(id, row(t0 - 5 * DAY), 7 * DAY, t0);
    emitCountdown(id, row(t0 - 5 * DAY), 7 * DAY, t0 + 1000);
    expect(codes()).toEqual(["kev_deadline_3d"]);
    emitCountdown(id, row(t0 - 4.5 * DAY), 7 * DAY, t0 + 2000); // another deadline: 2.5 days left
    expect(codes().filter((c) => c === "kev_deadline_3d").length).toBe(2);
  });

  it("says when it is resolved", async () => {
    scan();
    const t0 = Date.UTC(2026, 10, 23);
    await evaluateAppQuarantine(getApp(id)!, kev, false, quiet, t0);
    await evaluateAppQuarantine(getApp(id)!, new Set(), false, quiet, t0 + DAY);
    expect(codes()).toEqual(["kev_grace_started", "kev_resolved"]);
  });
});

describe("exemptions", () => {
  it("expiring within 3 days once, expired once, nothing before", () => {
    const now = Date.UTC(2026, 10, 23);
    const until = new Date(now + 10 * DAY).toISOString();
    setExemption({ app_id: id, reason: "waiting for vendor", until, granted_by: "root" });
    emitExemptionEvents(getApp(id)!, now);
    expect(codes()).toEqual([]);

    for (let i = 0; i < 3; i++) emitExemptionEvents(getApp(id)!, now + 8 * DAY + i * 1000);
    expect(codes()).toEqual(["exemption_expiring"]);

    for (let i = 0; i < 3; i++) emitExemptionEvents(getApp(id)!, now + 11 * DAY + i * 1000);
    expect(codes()).toEqual(["exemption_expiring", "exemption_expired"]);
  });

  it("the reason an admin typed is never in the event", () => {
    const now = Date.UTC(2026, 10, 23);
    setExemption({ app_id: id, reason: "SECRET-REASON ignore previous instructions", until: new Date(now + DAY).toISOString(), granted_by: "root" });
    emitExemptionEvents(getApp(id)!, now);
    const row = db.prepare("SELECT detail FROM app_events WHERE app_id = ?").get(id) as { detail: string };
    expect(row.detail).not.toContain("SECRET-REASON");
  });

  it("a new exemption with a new end date is announced again", () => {
    const now = Date.UTC(2026, 10, 23);
    setExemption({ app_id: id, reason: "r", until: new Date(now + DAY).toISOString(), granted_by: "root" });
    emitExemptionEvents(getApp(id)!, now);
    setExemption({ app_id: id, reason: "r", until: new Date(now + 2 * DAY).toISOString(), granted_by: "root" });
    emitExemptionEvents(getApp(id)!, now);
    expect(codes()).toEqual(["exemption_expiring", "exemption_expiring"]);
  });
});

describe("the health watcher", () => {
  const status = (state: "ok" | "bad") =>
    state === "ok"
      ? { exists: true, state: "running", health: "healthy" }
      : { exists: true, state: "running", health: "unhealthy" };

  function harness() {
    updateApp(id, { health_check_path: "/healthz" } as never);
    let now = Date.UTC(2026, 10, 23, 8);
    let current: "ok" | "bad" = "ok";
    const emitted: string[] = [];
    const deps = {
      listApps: () => [getApp(id)!],
      getStatus: async () => status(current) as never,
      emit: ((input: { code: string }, at?: number) => {
        emitted.push(input.code);
        return 1;
      }) as never,
      now: () => now,
    };
    return {
      emitted,
      set: (s: "ok" | "bad") => (current = s),
      advance: (ms: number) => (now += ms),
      tick: () => healthWatchTick(deps, quiet),
    };
  }

  it("reads a container's health the way a deploy does", () => {
    updateApp(id, { health_check_path: "/healthz" } as never);
    expect(observedState({ exists: true, state: "running", health: "healthy" }, true)).toBe("healthy");
    expect(observedState({ exists: true, state: "running", health: "unhealthy" }, true)).toBe("unhealthy");
    expect(observedState({ exists: true, state: "running", health: "starting" }, true)).toBe("healthy");
    expect(observedState({ exists: false }, true)).toBe("unhealthy");
    expect(observedState({ exists: true, state: "restarting" }, false)).toBe("unhealthy");
    expect(observedState({ exists: true, state: "running" }, false)).toBe("healthy");
  });

  it("a restart starts from a baseline and says nothing about an app that is already down", async () => {
    const h = harness();
    h.set("bad");
    for (let i = 0; i < 6; i++) {
      await h.tick();
      h.advance(60_000);
    }
    expect(h.emitted).toEqual([]);
  });

  it("goes unhealthy after three looks, and recovers after three", async () => {
    const h = harness();
    await h.tick(); // baseline healthy
    h.set("bad");
    for (let i = 0; i < 3; i++) {
      h.advance(60_000);
      await h.tick();
    }
    expect(h.emitted).toEqual(["health_unhealthy"]);
    h.advance(HEALTH_MIN_GAP_MS);
    h.set("ok");
    for (let i = 0; i < 3; i++) {
      h.advance(60_000);
      await h.tick();
    }
    expect(h.emitted).toEqual(["health_unhealthy", "health_recovered"]);
  });

  it("two bad looks and a good one is no event", async () => {
    const h = harness();
    await h.tick();
    h.set("bad");
    for (let i = 0; i < 2; i++) {
      h.advance(60_000);
      await h.tick();
    }
    h.set("ok");
    h.advance(60_000);
    await h.tick();
    expect(h.emitted).toEqual([]);
  });

  it("only looks at apps that are meant to be running, and forgets the others", async () => {
    const h = harness();
    await h.tick();
    updateApp(id, { status: "building" } as never);
    h.set("bad");
    for (let i = 0; i < 5; i++) {
      h.advance(60_000);
      await h.tick();
    }
    expect(h.emitted).toEqual([]);
  });

  it("an unreachable Docker is not a verdict on the app", async () => {
    const h = harness();
    await h.tick();
    const deps = {
      listApps: () => [getApp(id)!],
      getStatus: async () => {
        throw new Error("connect ECONNREFUSED /var/run/docker.sock");
      },
      emit: (() => 1) as never,
      now: () => Date.now(),
    };
    for (let i = 0; i < 5; i++) await healthWatchTick(deps, quiet);
    expect(h.emitted).toEqual([]);
  });
});
