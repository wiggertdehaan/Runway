/**
 * GET /security: who sees which apps, what the sidebar counter says, and
 * that nothing about somebody else's apps leaks into the page or the
 * counter. Drives the real app (session middleware included) against an
 * in-memory database; no Docker, no network.
 */
import { beforeAll, describe, expect, it } from "vitest";

import { app } from "../app.js";
import { migrate } from "../db/index.js";
import { createApp, updateApp } from "../db/apps.js";
import { saveQuarantine } from "../db/quarantine.js";
import { createSession } from "../db/sessions.js";
import { createUser } from "../db/users.js";

let sessions: Record<string, string> = {};
const ids: Record<string, string> = {};

const DAY = 86_400_000;

beforeAll(async () => {
  migrate();
  const admin = await createUser("root", "pw-root-123456", "admin");
  const alice = await createUser("alice", "pw-alice-123456", "member");
  const bob = await createUser("bob", "pw-bob-123456", "member");
  const carol = await createUser("carol", "pw-carol-123456", "member");
  sessions = {
    root: createSession(admin.id).token,
    alice: createSession(alice.id).token,
    bob: createSession(bob.id).token,
    carol: createSession(carol.id).token,
  };
  const mk = (key: string, owner: string | undefined, name: string, extra: Record<string, unknown> = {}) => {
    const a = createApp(owner);
    updateApp(a.id, { name, status: "running", image_tag: `runway/${key}:1`, ...extra } as never);
    ids[key] = a.id;
  };
  mk("aliceTerm", "alice", "alice-in-term");
  mk("aliceClean", "alice", "alice-clean");
  mk("bobDown", "bob", "bob-offline");
  mk("bobTerm", "bob", "bob-in-term");
  mk("orphan", undefined, "ownerless-app");
  const seen = { "CVE-2026-1000": new Date(Date.now() - 3 * DAY).toISOString() };
  saveQuarantine({ app_id: ids.aliceTerm, state: "grace", kev_first_seen: seen, attempt_at: null, quarantined_at: null });
  saveQuarantine({ app_id: ids.bobTerm, state: "grace", kev_first_seen: seen, attempt_at: null, quarantined_at: null });
  saveQuarantine({
    app_id: ids.bobDown,
    state: "quarantined",
    kev_first_seen: { "CVE-2026-2222": new Date(Date.now() - 9 * DAY).toISOString() },
    attempt_at: null,
    quarantined_at: new Date(Date.now() - DAY).toISOString(),
  });
});

const get = (path: string, who: string | null) =>
  app.request(path, { headers: who ? { cookie: `runway_session=${sessions[who]}` } : {} });

/** The sidebar badge as rendered, e.g. "2", or null when there is none. */
function navBadge(html: string): string | null {
  const m = html.match(/<a class="nav-link" href="\/security"[^>]*>[\s\S]*?<\/a>/);
  expect(m).not.toBeNull();
  const c = (m as RegExpMatchArray)[0].match(/class="nav-count"[^>]*>([^<]*)</);
  return c ? c[1] : null;
}

describe("GET /security", () => {
  it("sends an anonymous visitor to the login page", async () => {
    const r = await get("/security", null);
    expect(r.status).toBe(302);
    expect(r.headers.get("location") ?? "").toMatch(/login/);
  });

  it("shows an admin every app, with owners and the right counter", async () => {
    const r = await get("/security", "root");
    expect(r.status).toBe(200);
    const html = await r.text();
    expect(html).toContain("alice-in-term");
    expect(html).toContain("bob-in-term");
    expect(html).toContain("bob-offline");
    expect(html).toContain("owner alice");
    expect(html).toContain("owner bob");
    expect(navBadge(html)).toBe("3");
  });

  it("shows an owner only their own apps, and no other owner's name or CVE", async () => {
    const r = await get("/security", "alice");
    expect(r.status).toBe(200);
    const html = await r.text();
    expect(html).toContain("alice-in-term");
    expect(html).toContain("alice-clean");
    expect(html).not.toContain("bob-in-term");
    expect(html).not.toContain("bob-offline");
    expect(html).not.toContain("ownerless-app");
    expect(html).not.toContain("CVE-2026-2222");
    expect(html).not.toMatch(/owner (alice|bob)/);
    expect(navBadge(html)).toBe("1");
  });

  it("counts only the viewer's own apps in the sidebar badge, on every page", async () => {
    // bob has one offline and one in a term; alice one in a term.
    expect(navBadge(await (await get("/", "bob")).text())).toBe("2");
    expect(navBadge(await (await get("/", "alice")).text())).toBe("1");
    expect(navBadge(await (await get("/", "root")).text())).toBe("3");
  });

  it("has no badge and a calm page for an owner without risk or apps", async () => {
    const r = await get("/security", "carol");
    expect(r.status).toBe(200);
    const html = await r.text();
    expect(navBadge(html)).toBeNull();
    expect(html).toContain("No apps yet");
    expect(html).not.toContain("alice-in-term");
  });

  it("agrees with the home page: the same apps are counted as needing attention", async () => {
    const home = await (await get("/", "bob")).text();
    const page = await (await get("/security", "bob")).text();
    expect(home).toContain("2 apps need attention");
    expect(page).toContain('data-tile="offline"><b>1</b>');
    expect(page).toContain('data-tile="term"><b>1</b>');
  });
});
