/**
 * Stop / start / restart / trash / restore / purge with a real database and
 * Docker, the gateway and the health wait replaced by recorders.
 */
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const calls = vi.hoisted(() => [] as string[]);
const fake = vi.hoisted(() => ({
  containerImage: null as string | null,
  health: { healthy: true, reason: "ok" },
  stopThrows: false,
  gate: null as null | Promise<void>,
}));

vi.mock("./docker.js", async (orig) => {
  const real = await orig<typeof import("./docker.js")>();
  return {
    ...real,
    containerImageTag: vi.fn(async () => fake.containerImage),
    startContainerByName: vi.fn(async () => void calls.push("docker:start")),
    restartContainerByName: vi.fn(async () => void calls.push("docker:restart")),
    stopContainerByName: vi.fn(async () => {
      if (fake.gate) await fake.gate;
      if (fake.stopThrows) throw new Error("docker down");
      calls.push("docker:stop");
    }),
    removeContainerByName: vi.fn(async () => void calls.push("docker:remove")),
    runContainer: vi.fn(async () => {
      calls.push("docker:create");
      return { containerId: "c-new" };
    }),
  };
});
vi.mock("./gateway.js", async (orig) => {
  const real = await orig<typeof import("./gateway.js")>();
  return {
    ...real,
    writeAppRoute: vi.fn(async () => void calls.push("route:app")),
    writeMaintenanceRoute: vi.fn(async () => void calls.push("route:maintenance")),
    deleteAppRoute: vi.fn(async () => void calls.push("route:delete")),
  };
});
vi.mock("./health.js", () => ({
  waitForHealthy: vi.fn(async () => fake.health),
  judgeHealth: vi.fn(),
}));

import { db, migrate } from "../db/index.js";
import { createApp, getApp, isDomainTaken, listApps, updateApp, appsVisibleTo, listDeletedApps } from "../db/apps.js";
import { getQuarantine, saveQuarantine } from "../db/quarantine.js";
import {
  purgeApp,
  purgeExpiredTrash,
  restartApp,
  restoreFromTrash,
  startApp,
  stopApp,
  trashApp,
  TRASH_DAYS,
} from "./lifecycle.js";
import { rebuildableApps } from "./rebuild.js";
import { needsRouteRefresh } from "./gateway-sync.js";
import { healthWatchTick, resetHealthWatch } from "./health-watch.js";

beforeAll(() => migrate());
beforeEach(() => {
  db.exec("DELETE FROM apps");
  calls.length = 0;
  fake.containerImage = null;
  fake.health = { healthy: true, reason: "ok" };
  fake.stopThrows = false;
  fake.gate = null;
  resetHealthWatch();
});

function mk(over: Record<string, unknown> = {}) {
  const a = createApp();
  return updateApp(a.id, {
    name: "Shop",
    runtime: "node",
    port: 3000,
    domain: "shop.example.com",
    image_tag: "runway-app-x:v1",
    status: "running",
    ...over,
  } as never)!;
}
function codes(id: string): string[] {
  return (db.prepare(`SELECT code FROM app_events WHERE app_id = ? ORDER BY id`).all(id) as Array<{ code: string }>).map((r) => r.code);
}

describe("stop", () => {
  it("routes visitors to the maintenance page BEFORE stopping the container, keeps data, records the time and an event", async () => {
    const a = mk();
    const r = await stopApp(a.id);
    expect(r.ok && r.changed).toBe(true);
    expect(calls).toEqual(["route:maintenance", "docker:stop"]);
    const after = getApp(a.id)!;
    expect(after.status).toBe("stopped");
    expect(after.stopped_at).toBeTruthy();
    expect(after.image_tag).toBe("runway-app-x:v1");
    expect(after.domain).toBe("shop.example.com");
    expect(codes(a.id)).toEqual(["app_stopped"]);
  });
  it("a second stop (double click) changes nothing and adds no event", async () => {
    const a = mk();
    await stopApp(a.id);
    calls.length = 0;
    const r = await stopApp(a.id);
    expect(r).toMatchObject({ ok: true, changed: false });
    expect(calls).toEqual([]);
    expect(codes(a.id)).toEqual(["app_stopped"]);
  });
  it("two stops at the same moment: the second is refused as busy", async () => {
    const a = mk();
    let release!: () => void;
    fake.gate = new Promise<void>((r) => (release = r));
    const first = stopApp(a.id);
    await Promise.resolve();
    const second = await stopApp(a.id);
    expect(second).toMatchObject({ ok: false, code: "busy" });
    release();
    expect(await first).toMatchObject({ ok: true, changed: true });
    expect(codes(a.id)).toEqual(["app_stopped"]);
  });
  it.each(["building", "scanning", "starting"])("is refused while a deploy is %s, nothing touched", async (status) => {
    const a = mk({ status });
    const r = await stopApp(a.id);
    expect(r).toMatchObject({ ok: false, code: "busy" });
    expect(calls).toEqual([]);
    expect(getApp(a.id)!.status).toBe(status);
  });
  it("a quarantined app: allowed, container stays off, status stays quarantined, no stopped_at", async () => {
    const a = mk({ status: "quarantined" });
    const r = await stopApp(a.id);
    expect(r).toMatchObject({ ok: true, changed: false });
    expect(getApp(a.id)!.status).toBe("quarantined");
    expect(getApp(a.id)!.stopped_at).toBeNull();
    expect(calls).not.toContain("route:maintenance");
  });
  it("if Docker fails the real route is put back and the status stays", async () => {
    const a = mk();
    fake.stopThrows = true;
    await expect(stopApp(a.id)).rejects.toThrow("docker down");
    expect(calls).toEqual(["route:maintenance", "route:app"]);
    expect(getApp(a.id)!.status).toBe("running");
  });
  it("unknown app", async () => {
    expect(await stopApp("nope")).toMatchObject({ ok: false, code: "not_found" });
  });
});

describe("start", () => {
  it("same version: docker start (no rebuild, no new container), live only after health, app route written after", async () => {
    const a = mk();
    await stopApp(a.id);
    calls.length = 0;
    fake.containerImage = "runway-app-x:v1";
    const r = await startApp(a.id);
    expect(r).toMatchObject({ ok: true, changed: true });
    expect(calls).toEqual(["docker:start", "route:app"]);
    const after = getApp(a.id)!;
    expect(after.status).toBe("running");
    expect(after.stopped_at).toBeNull();
    expect(codes(a.id)).toEqual(["app_stopped", "app_started"]);
  });
  it("creates the container when it is gone or from another image", async () => {
    const a = mk({ status: "stopped" });
    fake.containerImage = null;
    await startApp(a.id);
    expect(calls).toEqual(["docker:remove", "docker:create", "route:app"]);
  });
  it("not healthy: stopped again, maintenance page kept, status failed, event, error says why", async () => {
    const a = mk({ status: "stopped", stopped_at: new Date().toISOString() });
    fake.containerImage = "runway-app-x:v1";
    fake.health = { healthy: false, reason: "container exited" };
    const r = await startApp(a.id);
    expect(r).toMatchObject({ ok: false, code: "unhealthy" });
    expect(!r.ok && r.message).toContain("container exited");
    expect(calls).toEqual(["docker:start", "docker:stop", "route:maintenance"]);
    expect(calls).not.toContain("route:app");
    expect(getApp(a.id)!.status).toBe("failed");
    expect(codes(a.id)).toEqual(["app_start_failed"]);
  });
  it("a start on a running app is a no-op", async () => {
    const a = mk();
    expect(await startApp(a.id)).toMatchObject({ ok: true, changed: false });
    expect(calls).toEqual([]);
  });
  it("a quarantined app is refused with the reason and nothing is started", async () => {
    const a = mk({ status: "quarantined" });
    const r = await startApp(a.id);
    expect(r).toMatchObject({ ok: false, code: "quarantined" });
    expect(calls).toEqual([]);
  });
  it("an app that was never deployed cannot be started", async () => {
    const a = mk({ status: "stopped", image_tag: null });
    expect(await startApp(a.id)).toMatchObject({ ok: false, code: "no_image" });
  });
  it("refused while a deploy is running", async () => {
    const a = mk({ status: "building" });
    expect(await startApp(a.id)).toMatchObject({ ok: false, code: "busy" });
  });
  it("the KEV fix period does not run while the app was off: first-seen times move forward by the stop time", async () => {
    const a = mk({ status: "stopped", stopped_at: new Date(Date.now() - 3 * 86_400_000).toISOString() });
    const seen = new Date(Date.now() - 10 * 86_400_000).toISOString();
    saveQuarantine({ app_id: a.id, state: "grace", kev_first_seen: { "CVE-2026-1": seen }, attempt_at: null, quarantined_at: null });
    fake.containerImage = "runway-app-x:v1";
    await startApp(a.id);
    const shifted = Date.parse(getQuarantine(a.id)!.kev_first_seen["CVE-2026-1"]!);
    expect(shifted - Date.parse(seen)).toBeGreaterThan(3 * 86_400_000 - 5_000);
    expect(shifted - Date.parse(seen)).toBeLessThan(3 * 86_400_000 + 60_000);
  });
});

describe("restart", () => {
  it("running app: docker restart, health, event app_restarted", async () => {
    const a = mk();
    fake.containerImage = "runway-app-x:v1";
    const r = await restartApp(a.id);
    expect(r).toMatchObject({ ok: true, changed: true });
    expect(calls).toEqual(["docker:restart", "route:app"]);
    expect(codes(a.id)).toEqual(["app_restarted"]);
    expect(getApp(a.id)!.status).toBe("running");
  });
  it("a stopped app: same as start", async () => {
    const a = mk({ status: "stopped" });
    fake.containerImage = "runway-app-x:v1";
    await restartApp(a.id);
    expect(calls).toContain("docker:start");
    expect(codes(a.id)).toEqual(["app_started"]);
  });
  it("does not come back healthy: failed + event", async () => {
    const a = mk();
    fake.containerImage = "runway-app-x:v1";
    fake.health = { healthy: false, reason: "timeout" };
    expect(await restartApp(a.id)).toMatchObject({ ok: false, code: "unhealthy" });
    expect(getApp(a.id)!.status).toBe("failed");
  });
  it("refused for a quarantined app and while building", async () => {
    expect(await restartApp(mk({ status: "quarantined" }).id)).toMatchObject({ ok: false, code: "quarantined" });
    expect(await restartApp(mk({ status: "scanning", name: "Other", domain: "o.example.com" }).id)).toMatchObject({ ok: false, code: "busy" });
  });
});

describe("a stopped app is left alone by the jobs", () => {
  it("rebuilds, health watch, route refresh and quarantine do not touch it", async () => {
    const a = mk({ status: "stopped" });
    expect(rebuildableApps().map((x) => x.id)).not.toContain(a.id);
    expect(needsRouteRefresh(getApp(a.id)!)).toBe(false);
    const getStatus = vi.fn(async () => ({ exists: true }));
    await healthWatchTick({ listApps, getStatus, emit: vi.fn() as never, now: Date.now }, console);
    expect(getStatus).not.toHaveBeenCalled();
    const { evaluateAppQuarantine } = await import("./quarantine.js");
    expect(await evaluateAppQuarantine(getApp(a.id)!, new Set(["CVE-2026-1"]), false)).toEqual([]);
  });
});

describe("trash", () => {
  it("needs the exact name; anything else changes nothing", async () => {
    const a = mk();
    for (const wrong of [undefined, "", "shop", "Shop ", "SHOP", 5, "Shop; drop"]) {
      const r = await trashApp(a.id, wrong);
      if (wrong === "Shop ") expect(r.ok).toBe(true);
      else expect(r).toMatchObject({ ok: false, code: "confirm" });
      if (r.ok) await restoreFromTrash(a.id);
    }
    expect(getApp(a.id)!.deleted_at).toBeNull();
  });
  it("an app without a name is confirmed by its id", async () => {
    const a = createApp();
    expect(await trashApp(a.id, "x")).toMatchObject({ ok: false, code: "confirm" });
    expect(await trashApp(a.id, a.id)).toMatchObject({ ok: true });
  });
  it("stops it, sets deleted_at, hides it from the normal list and from jobs, keeps the data, event", async () => {
    const a = mk();
    const r = await trashApp(a.id, "Shop");
    expect(r).toMatchObject({ ok: true, changed: true });
    expect(calls).toEqual(["route:maintenance", "docker:stop"]);
    const after = getApp(a.id)!;
    expect(after.deleted_at).toBeTruthy();
    expect(after.status).toBe("stopped");
    expect(after.image_tag).toBe("runway-app-x:v1");
    expect(listApps().map((x) => x.id)).not.toContain(a.id);
    expect(listDeletedApps().map((x) => x.id)).toEqual([a.id]);
    expect(appsVisibleTo("anyone", true).map((x) => x.id)).not.toContain(a.id);
    expect(codes(a.id)).toEqual(["app_deleted"]);
    expect(calls).not.toContain("route:delete");
  });
  it("the domain stays reserved while it is in the trash", async () => {
    const a = mk();
    await trashApp(a.id, "Shop");
    const other = createApp();
    expect(isDomainTaken("shop.example.com", other.id)).toBe(true);
    expect(() => updateApp(other.id, { domain: "shop.example.com" } as never)).toThrow();
  });
  it("is refused while a deploy runs, and an app already in the trash cannot be acted on", async () => {
    expect(await trashApp(mk({ status: "building" }).id, "Shop")).toMatchObject({ ok: false, code: "busy" });
    const b = mk({ name: "B", domain: "b.example.com" });
    await trashApp(b.id, "B");
    expect(await startApp(b.id)).toMatchObject({ ok: false, code: "in_trash" });
    expect(await stopApp(b.id)).toMatchObject({ ok: false, code: "in_trash" });
    expect(await trashApp(b.id, "B")).toMatchObject({ ok: false, code: "in_trash" });
  });
  it("a quarantined app keeps its quarantine status through trash and restore", async () => {
    const a = mk({ status: "quarantined" });
    saveQuarantine({ app_id: a.id, state: "quarantined", kev_first_seen: {}, attempt_at: null, quarantined_at: new Date().toISOString() });
    await trashApp(a.id, "Shop");
    expect(getApp(a.id)!.status).toBe("quarantined");
    await restoreFromTrash(a.id);
    expect(getApp(a.id)!.status).toBe("quarantined");
    expect(await startApp(a.id)).toMatchObject({ ok: false, code: "quarantined" });
  });
});

describe("restore", () => {
  it("brings it back as a STOPPED app with its data; start is a separate step", async () => {
    const a = mk();
    await trashApp(a.id, "Shop");
    calls.length = 0;
    const r = await restoreFromTrash(a.id);
    expect(r).toMatchObject({ ok: true });
    const after = getApp(a.id)!;
    expect(after.deleted_at).toBeNull();
    expect(after.status).toBe("stopped");
    expect(after.image_tag).toBe("runway-app-x:v1");
    expect(listApps().map((x) => x.id)).toContain(a.id);
    expect(calls).toEqual([]);
    expect(codes(a.id)).toEqual(["app_deleted", "app_restored"]);
    fake.containerImage = "runway-app-x:v1";
    expect(await startApp(a.id)).toMatchObject({ ok: true, changed: true });
  });
  it("restoring an app that is not in the trash is refused", async () => {
    expect(await restoreFromTrash(mk().id)).toMatchObject({ ok: false, code: "not_in_trash" });
  });
  it("survives a server restart: the state is in the database, nothing in memory is needed", async () => {
    const a = mk();
    await trashApp(a.id, "Shop");
    // a restart drops the in-memory locks and caches; the row is all there is
    expect(getApp(a.id)!.deleted_at).toBeTruthy();
    expect(await restoreFromTrash(a.id)).toMatchObject({ ok: true });
  });
});

describe("purge", () => {
  it("only from the trash, with the name (or skipConfirm for the job)", async () => {
    const a = mk();
    expect(await purgeApp(a.id, { confirm: "Shop" })).toMatchObject({ ok: false, code: "not_in_trash" });
    await trashApp(a.id, "Shop");
    expect(await purgeApp(a.id, { confirm: "nope" })).toMatchObject({ ok: false, code: "confirm" });
    expect(getApp(a.id)).toBeTruthy();
    calls.length = 0;
    expect(await purgeApp(a.id, { confirm: "Shop" })).toMatchObject({ ok: true });
    expect(getApp(a.id)).toBeUndefined();
    expect(calls).toContain("route:delete");
    expect(calls).toContain("docker:remove");
  });
  it("the job removes only apps older than the trash term, and is idempotent", async () => {
    const old = mk({ name: "Old", domain: "old.example.com" });
    const fresh = mk({ name: "Fresh", domain: "fresh.example.com" });
    await trashApp(old.id, "Old");
    await trashApp(fresh.id, "Fresh");
    const now = Date.now();
    db.prepare(`UPDATE apps SET deleted_at = ? WHERE id = ?`).run(new Date(now - (TRASH_DAYS * 86_400_000 + 1000)).toISOString(), old.id);
    db.prepare(`UPDATE apps SET deleted_at = ? WHERE id = ?`).run(new Date(now - (TRASH_DAYS * 86_400_000 - 60_000)).toISOString(), fresh.id);
    const quiet = { log: () => {}, error: () => {} };
    expect(await purgeExpiredTrash(now, quiet)).toEqual([old.id]);
    expect(getApp(old.id)).toBeUndefined();
    expect(getApp(fresh.id)).toBeTruthy();
    expect(await purgeExpiredTrash(now, quiet)).toEqual([]);
    expect(await purgeExpiredTrash(now + 2 * 86_400_000, quiet)).toEqual([fresh.id]);
    expect(await purgeExpiredTrash(now + 3 * 86_400_000, quiet)).toEqual([]);
  });
  it("never removes a normal app, and one failing purge does not stop the others", async () => {
    const live = mk({ name: "Live", domain: "live.example.com" });
    const a = mk({ name: "A", domain: "a.example.com" });
    const b = mk({ name: "B", domain: "b.example.com" });
    await trashApp(a.id, "A");
    await trashApp(b.id, "B");
    const long = new Date(Date.now() - 30 * 86_400_000).toISOString();
    db.prepare(`UPDATE apps SET deleted_at = ? WHERE id IN (?, ?)`).run(long, a.id, b.id);
    const gw = await import("./gateway.js");
    vi.mocked(gw.deleteAppRoute).mockRejectedValueOnce(new Error("disk full"));
    const errors: string[] = [];
    const purged = await purgeExpiredTrash(Date.now(), { log: () => {}, error: (m: string) => void errors.push(m) });
    expect(purged).toHaveLength(1);
    expect(errors.join()).toContain("purge failed");
    expect(getApp(live.id)).toBeTruthy();
    // the failed one is retried by the next sweep
    expect(await purgeExpiredTrash(Date.now(), { log: () => {}, error: () => {} })).toHaveLength(1);
  });
});
