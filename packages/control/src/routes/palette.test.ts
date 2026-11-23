/**
 * The command palette ships its entries inside every dashboard page. Who
 * gets which entries is decided on the server; this drives the real app
 * (sessions included) and checks that an owner never receives another
 * person's app names or an admin-only page, and that a visitor without a
 * session gets no palette at all.
 */
import { beforeAll, describe, expect, it } from "vitest";

import { app } from "../app.js";
import { migrate } from "../db/index.js";
import { createApp, updateApp } from "../db/apps.js";
import { createSession } from "../db/sessions.js";
import { createUser } from "../db/users.js";

let sessions: Record<string, string> = {};
const ids: Record<string, string> = {};

beforeAll(async () => {
  migrate();
  const admin = await createUser("root", "pw-root-123456", "admin");
  const alice = await createUser("alice", "pw-alice-123456", "member");
  const bob = await createUser("bob", "pw-bob-123456", "member");
  sessions = {
    root: createSession(admin.id).token,
    alice: createSession(alice.id).token,
    bob: createSession(bob.id).token,
  };
  const mk = (key: string, owner: string | undefined, name: string) => {
    const a = createApp(owner);
    updateApp(a.id, { name, status: "running", image_tag: `runway/${key}:1` } as never);
    ids[key] = a.id;
  };
  mk("alice1", "alice", "alice-planner");
  mk("bob1", "bob", "bob-secret-app");
  mk("orphan", undefined, "ownerless-app");
});

const get = (path: string, who: string | null) =>
  app.request(path, { headers: who ? { cookie: `runway_session=${sessions[who]}` } : {} });

interface Item {
  g: string;
  t: string;
  h?: string;
  a?: string;
}

async function paletteOf(path: string, who: string): Promise<{ html: string; items: Item[] }> {
  const res = await get(path, who);
  expect(res.status).toBe(200);
  const html = await res.text();
  const m = html.match(/<script type="application\/json" id="palette-data">([\s\S]*?)<\/script>/);
  expect(m).not.toBeNull();
  return { html, items: JSON.parse(m![1]) as Item[] };
}

describe("palette data per role", () => {
  it("gives an owner their own apps only, with no admin pages", async () => {
    const { html, items } = await paletteOf("/", "alice");
    const titles = items.map((i) => i.t);
    expect(titles).toContain("alice-planner");
    expect(titles).not.toContain("bob-secret-app");
    expect(titles).not.toContain("ownerless-app");
    for (const p of ["Rebuild", "Audit", "Health", "Users", "Skills", "Settings"]) {
      expect(titles).not.toContain(p);
    }
    expect(items.some((i) => i.h === "/settings" || i.h === "/users" || i.h === "/rebuild")).toBe(false);
    // Nothing about somebody else's apps anywhere in the page, ids included.
    expect(html).not.toContain("bob-secret-app");
    expect(html).not.toContain(ids.bob1);
    expect(html).not.toContain("ownerless-app");
  });

  it("gives an admin every app and every admin page", async () => {
    const { items } = await paletteOf("/", "root");
    const titles = items.map((i) => i.t);
    for (const n of ["alice-planner", "bob-secret-app", "ownerless-app"]) expect(titles).toContain(n);
    for (const p of ["Rebuild", "Audit", "Health", "Users", "Skills", "Settings"]) {
      expect(titles).toContain(p);
    }
  });

  it("is on every dashboard page, scoped the same way", async () => {
    for (const path of ["/security", "/account"]) {
      const { html, items } = await paletteOf(path, "bob");
      expect(items.map((i) => i.t)).toContain("bob-secret-app");
      expect(html).not.toContain("alice-planner");
    }
  });

  it("only offers links under this site and the local theme toggle", async () => {
    const { items } = await paletteOf("/", "root");
    for (const i of items) {
      if (i.h) expect(i.h).toMatch(/^\/(?!\/)/);
      else expect(i.a).toBe("theme");
    }
  });

  it("puts the search button in the sidebar and in the top bar, and loads the script", async () => {
    const { html } = await paletteOf("/", "alice");
    expect(html.match(/data-act="palette"/g)?.length).toBe(2);
    expect(html).toContain('id="palette"');
    expect(html).toContain("function paletteRank");
  });

  it("gives a visitor without a session no palette", async () => {
    const res = await get("/login", null);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).not.toContain("palette-data");
    expect(html).not.toContain("paletteRank");
    expect(html).not.toContain('data-act="palette"');
  });

  it("sends an anonymous request for a page to the login", async () => {
    const res = await get("/security", null);
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toContain("/login");
  });
});
