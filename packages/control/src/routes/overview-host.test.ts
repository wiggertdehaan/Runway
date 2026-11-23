/**
 * GET /overview with host figures, over the real app and an in-memory database:
 * the administrator sees the server block built from what the collector stored,
 * an owner's page (and its HTML source) holds nothing of it.
 */
import { beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("../overview/health.js", async (orig) => {
  const real = await orig<typeof import("../overview/health.js")>();
  return { ...real, cachedHealth: async () => ({ total: 8, failed: [] }) };
});

import { app } from "../app.js";
import { createApp, updateApp } from "../db/apps.js";
import { db, migrate } from "../db/index.js";
import { createSession } from "../db/sessions.js";
import { createUser } from "../db/users.js";
import { recordSample, setState } from "../host/store.js";

const GB = 1e9;
let sessions: Record<string, string> = {};

const seed = (opts: { diskPct?: number; container?: boolean; noData?: boolean } = {}) => {
  db.exec("DELETE FROM host_metrics");
  db.exec("DELETE FROM host_state");
  if (opts.noData) return;
  const now = Date.now();
  const total = 200 * GB;
  const used = (total * (opts.diskPct ?? 50)) / 100;
  setState("disk_last", JSON.stringify({ total, used, free: total - used, pct: opts.diskPct ?? 50 }), now);
  setState("view:disk", opts.container ? "container" : "host", now);
  if (opts.container) setState("reason:disk", "the data volume is only 300 MiB in total", now);
  setState("mem_total_bytes", String(16 * GB), now);
  for (let i = 0; i < 12; i++) {
    const at = now - i * 3_600_000;
    recordSample("cpu_pct", 20 + (i % 3), at);
    recordSample("mem_used_bytes", 8 * GB, at);
  }
  recordSample("data_images_bytes", 20 * GB, now);
  recordSample("data_containers_bytes", 1 * GB, now);
  recordSample("data_volumes_bytes", 10 * GB, now);
  recordSample("data_buildcache_bytes", 10 * GB, now);
  setState("data_note", "", now);
};

beforeAll(async () => {
  migrate();
  const admin = await createUser("root", "pw-root-123456", "admin");
  const alice = await createUser("alice", "pw-alice-123456", "member");
  sessions = { root: createSession(admin.id).token, alice: createSession(alice.id).token };
  const a = createApp("alice");
  updateApp(a.id, { name: "alice-shop", runtime: "node", status: "running", image_tag: "runway/a:1" } as never);
});

const get = (path: string, who: string | null) =>
  app.request(path, { headers: who ? { cookie: `runway_session=${sessions[who]}` } : {} });

describe("GET /overview server block", () => {
  it("shows an administrator the disk, CPU, memory and data the collector stored", async () => {
    seed({ diskPct: 62 });
    const html = await (await get("/overview", "root")).text();
    expect(html).toContain(">Disk<");
    expect(html).toContain("62%");
    expect(html).toContain("76.0 GB free");
    expect(html).toContain('id="server"');
    expect(html).toContain("data-stat=\"cpu\"");
    expect(html).toContain("data-stat=\"mem\"");
    expect(html).toContain("41.0 GB"); // 20 + 1 + 10 + 10
    expect(html).not.toContain("Server disk is");
  });

  it("raises 'Server disk is N% full' at 85 and 95 percent, only for an administrator", async () => {
    seed({ diskPct: 85 });
    let html = await (await get("/overview", "root")).text();
    expect(html).toContain("Server disk is 85% full");
    seed({ diskPct: 95 });
    html = await (await get("/overview", "root")).text();
    expect(html).toContain("Server disk is 95% full");
    const owner = await (await get("/overview", "alice")).text();
    expect(owner).not.toContain("Server disk");
  });

  it("shows a container-view disk grey, with no alarm", async () => {
    seed({ diskPct: 97, container: true });
    const html = await (await get("/overview", "root")).text();
    expect(html).toContain("Container view, not the host");
    expect(html).toContain("Disk reading is not the host&#39;s");
    expect(html).not.toContain("Server disk is");
  });

  it("says 'No data yet' on a fresh install before the first reading", async () => {
    seed({ noData: true });
    const html = await (await get("/overview", "root")).text();
    expect(html).toContain("No data yet");
    expect(html).not.toContain("Server disk is");
  });

  it("gives an owner nothing of it, not even in the HTML source", async () => {
    seed({ diskPct: 99 });
    const r = await get("/overview", "alice");
    expect(r.status).toBe(200);
    const html = await r.text();
    for (const leak of [">Disk<", "Server disk", "CPU", "Memory", "76.0 GB", "41.0 GB", "#server", 'id="server"', "host_metrics", "Container view"]) {
      expect(html).not.toContain(leak);
    }
    expect(html).toContain(">Expiring<");
  });

  it("keeps the period switch working for the server statistics", async () => {
    seed({ diskPct: 50 });
    for (const p of ["24h", "7d", "30d"]) {
      const r = await get(`/overview?period=${p}`, "root");
      expect(r.status).toBe(200);
      expect(await r.text()).toContain('data-stat="cpu"');
    }
  });
});
