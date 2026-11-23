/**
 * GET /rebuild: the run result page is for administrators. A member
 * (including an app owner) is sent away and never sees another app's
 * name, a failure reason or a scan count. Drives the real app against an
 * in-memory database; no Docker, no network.
 */
import { beforeAll, describe, expect, it } from "vitest";

import { app } from "../app.js";
import { migrate } from "../db/index.js";
import { createApp, updateApp } from "../db/apps.js";
import { saveQuarantine } from "../db/quarantine.js";
import { createSession } from "../db/sessions.js";
import { createUser } from "../db/users.js";
import { createRebuildRun, finishRebuildRun, saveRebuildResults } from "../db/rebuild-runs.js";

let sessions: Record<string, string> = {};

const counts = (critical: number, high: number) => ({ critical, high, medium: 0, low: 0, unknown: 0 });

beforeAll(async () => {
  migrate();
  const admin = await createUser("root", "pw-root-123456", "admin");
  const alice = await createUser("alice", "pw-alice-123456", "member");
  sessions = { root: createSession(admin.id).token, alice: createSession(alice.id).token };

  const q = createApp(undefined);
  updateApp(q.id, { name: "in-term-app", status: "running", image_tag: "runway/q:1" } as never);
  saveQuarantine({
    app_id: q.id,
    state: "grace",
    kev_first_seen: { "CVE-2026-1000": new Date(Date.now() - 86_400_000).toISOString() },
    attempt_at: null,
    quarantined_at: null,
  });

  const old = createRebuildRun("manual");
  saveRebuildResults(old, [
    { app_id: "o1", app_name: "bob-secret-app", outcome: "rebuilt", before: null, after: null },
  ]);
  finishRebuildRun(old);

  const id = createRebuildRun("scheduled");
  saveRebuildResults(id, [
    {
      app_id: "x1",
      app_name: "klantportaal",
      outcome: "rebuilt",
      before: { counts: counts(0, 2), kev: 0 },
      after: { counts: counts(0, 0), kev: 0 },
      patched: [{ from: "node:22.11.0", to: "node:22.11.3" }],
    },
    {
      app_id: "x2",
      app_name: "ledenlijst",
      outcome: "failed",
      before: { counts: counts(0, 1), kev: 0 },
      after: null,
      detail: 'failed to solve: process "/bin/sh -c npm ci" exit code: 1 token=supersecret123',
    },
    { app_id: "x3", app_name: "oud-prototype", outcome: "skipped", before: null, after: null, detail: "never deployed" },
  ]);
  finishRebuildRun(id);
});

const get = (who: string | null) =>
  app.request("/rebuild", { headers: who ? { cookie: `runway_session=${sessions[who]}` } : {} });

describe("GET /rebuild", () => {
  it("sends an anonymous visitor to the login page", async () => {
    const r = await get(null);
    expect(r.status).toBe(302);
    expect(r.headers.get("location") ?? "").toMatch(/login/);
  });

  it("sends a member away without showing any result", async () => {
    const r = await get("alice");
    expect(r.status).toBe(302);
    expect(r.headers.get("location")).toBe("/?forbidden=1");
    expect(await r.text()).not.toContain("klantportaal");
  });

  it("shows an admin the latest run in words, with tiles", async () => {
    const r = await get("root");
    expect(r.status).toBe(200);
    const html = await r.text();
    expect(html).toContain("Run #2 result");
    expect(html).toContain("klantportaal");
    expect(html).toContain("ledenlijst");
    expect(html).toContain("Rebuilt");
    expect(html).toContain("Failed");
    expect(html).toContain("0C 2H → 0C 0H");
    expect(html).toContain("Base image node:22.11.0 to node:22.11.3.");
    expect(html).toContain('data-tile="skipped"');
    expect(html).toContain("Earlier runs");
    expect(html).toContain("bob-secret-app");
  });

  it("never shows raw build output or a secret from a failure, even to an admin", async () => {
    const html = await (await get("root")).text();
    expect(html).toContain("A build step failed.");
    expect(html).not.toContain("supersecret123");
    expect(html).not.toContain("npm ci");
    expect(html).not.toContain("failed to solve");
  });

  it("lists KEV terms as labelled rows that become cards on a phone", async () => {
    const html = await (await get("root")).text();
    expect(html).toContain("in-term-app");
    expect(html).toContain('data-label="Actively exploited"');
    expect(html).toContain("CVE-2026-1000");
    expect(html).toContain("Term running");
    expect(html).toContain("sec-row-warn");
  });

  it("does not reuse the class of the app page's rebuild line", async () => {
    const html = await (await get("root")).text();
    expect(html).not.toContain('class="rb-line');
    expect(html).toContain('class="rr-line');
  });

  it("keeps the schedule and the quarantine term as settings", async () => {
    const html = await (await get("root")).text();
    expect(html).toContain("<h2 class=\"sec-h\">Settings</h2>");
    expect(html).toContain('action="/rebuild/schedule"');
    expect(html).toContain('action="/rebuild/quarantine-term"');
    expect(html).toContain('action="/rebuild/run"');
  });
});
