/**
 * S03: two apps must never get the same hostname. Drives the real API
 * (Bearer app keys) against an in-memory database.
 */
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { app } from "../app.js";
import { db, migrate } from "../db/index.js";
import { createApp, getApp, updateApp } from "../db/apps.js";
import { setSetting } from "../db/settings.js";

let alice = { id: "", key: "" };
let bob = { id: "", key: "" };

beforeAll(() => {
  migrate();
  process.env.DASHBOARD_DOMAIN = "runway.example.com";
});

beforeEach(() => {
  db.exec("DELETE FROM apps");
  setSetting("base_domain", "example.com");
  const a = createApp("alice");
  const b = createApp("bob");
  alice = { id: a.id, key: a.api_key };
  bob = { id: b.id, key: b.api_key };
});

function configure(who: { key: string }, name: string) {
  return app.request("/api/v1/app/configure", {
    method: "POST",
    headers: { authorization: `Bearer ${who.key}`, "content-type": "application/json" },
    body: JSON.stringify({ name, runtime: "node" }),
  });
}
function putDomain(who: { key: string }, custom_domain: string) {
  return app.request("/api/v1/app/domain", {
    method: "PUT",
    headers: { authorization: `Bearer ${who.key}`, "content-type": "application/json" },
    body: JSON.stringify({ custom_domain }),
  });
}

describe("POST /api/v1/app/configure", () => {
  it("gives the first app the name's subdomain", async () => {
    const res = await configure(alice, "Shop");
    expect(res.status).toBe(200);
    expect(getApp(alice.id)!.domain).toBe("shop.example.com");
  });

  it("refuses a second app with the same name, and leaves it unconfigured", async () => {
    await configure(alice, "Shop");
    const res = await configure(bob, "Shop");
    expect(res.status).toBe(409);
    expect(getApp(bob.id)!.domain).toBeNull();
    expect(getApp(alice.id)!.domain).toBe("shop.example.com");
  });

  it("treats other spellings of the same slug as the same name", async () => {
    await configure(alice, "My Shop");
    expect((await configure(bob, "my-shop")).status).toBe(409);
    expect((await configure(bob, "MY  SHOP!")).status).toBe(409);
  });

  it("lets an app re-configure with its own name", async () => {
    await configure(alice, "Shop");
    expect((await configure(alice, "Shop")).status).toBe(200);
  });

  it("the refusal does not reveal who or which app holds the name", async () => {
    await configure(alice, "Shop");
    const res = await configure(bob, "Shop");
    const text = await res.text();
    expect(text).not.toContain(alice.id);
    expect(text).not.toContain("alice");
    expect(text).not.toContain("shop.example.com");
  });

  it("refuses a name that would take the dashboard's hostname", async () => {
    const res = await configure(alice, "runway");
    expect(res.status).toBe(400);
    expect(getApp(alice.id)!.domain).toBeNull();
  });

  it("refuses a name whose subdomain is another app's custom domain", async () => {
    updateApp(bob.id, { custom_domain: "shop.example.com" });
    expect((await configure(alice, "Shop")).status).toBe(409);
  });

  it("without a base domain there is no generated domain and no clash", async () => {
    db.prepare("DELETE FROM settings WHERE key = 'base_domain'").run();
    expect((await configure(alice, "Shop")).status).toBe(200);
    expect((await configure(bob, "Shop")).status).toBe(200);
  });

  it("anonymous callers are refused", async () => {
    const res = await app.request("/api/v1/app/configure", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "Shop", runtime: "node" }),
    });
    expect(res.status).toBe(401);
  });
});

describe("PUT /api/v1/app/domain (custom domain)", () => {
  it("refuses another app's custom domain, any case, with a trailing dot", async () => {
    expect((await putDomain(alice, "www.mine.org")).status).toBe(200);
    expect((await putDomain(bob, "WWW.Mine.org.")).status).toBe(400);
    expect(getApp(bob.id)!.custom_domain).toBeNull();
  });

  it("refuses another app's generated domain", async () => {
    await configure(alice, "Shop");
    expect((await putDomain(bob, "shop.example.com")).status).toBe(400);
  });

  it("lets an app save its own custom domain again", async () => {
    await putDomain(alice, "www.mine.org");
    expect((await putDomain(alice, "www.mine.org")).status).toBe(200);
  });
});
