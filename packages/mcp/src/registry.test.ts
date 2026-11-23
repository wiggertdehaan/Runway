/**
 * Step 14: which server, which app, which credential. The rule that matters
 * most: a call goes to ITS server with ITS credential and nobody else's.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { RunwayUsageError } from "./errors.js";
import {
  APP_KEY_X,
  APP_KEY_Y,
  SERVER_A,
  SERVER_B,
  SERVER_C,
  TOKEN_A,
  TOKEN_B,
  json,
  legacyRegistry,
  registryOf,
  stubServers,
} from "./testkit.js";

afterEach(() => vi.unstubAllGlobals());

describe("choosing the server", () => {
  it("with one server the name is optional; with several it is required and never guessed", () => {
    const one = registryOf(SERVER_A);
    expect(one.resolve().name).toBe("alpha");
    expect(one.resolve("alpha").name).toBe("alpha");

    const many = registryOf(SERVER_A, SERVER_B);
    expect(() => many.resolve()).toThrow(RunwayUsageError);
    expect(() => many.resolve()).toThrow(/alpha, beta/);
    expect(many.resolve("beta").name).toBe("beta");
    expect(many.resolve(" BETA ").name).toBe("beta");
  });

  it("an unknown name lists the real ones", () => {
    expect(() => registryOf(SERVER_A, SERVER_B).resolve("nope")).toThrow(/No Runway called 'nope'.*alpha, beta/);
  });

  it("select() is the named server, or all of them", () => {
    const r = registryOf(SERVER_A, SERVER_B);
    expect(r.select().map((s) => s.name)).toEqual(["alpha", "beta"]);
    expect(r.select("beta").map((s) => s.name)).toEqual(["beta"]);
    expect(() => r.select("nope")).toThrow(RunwayUsageError);
  });
});

describe("choosing the app and the credential", () => {
  it("a user token needs an app for an app call, and sends it as X-Runway-App", async () => {
    const calls = stubServers({ "alpha.example.com": () => json({ app_id: "app1" }) });
    const r = registryOf(SERVER_A);
    expect(() => r.clientFor(undefined, undefined)).toThrow(/say which one with `app`/);
    await r.clientFor(undefined, "app1").client.getStatus();
    expect(calls).toHaveLength(1);
    expect(calls[0]!.headers.Authorization).toBe(`Bearer ${TOKEN_A}`);
    expect(calls[0]!.headers["X-Runway-App"]).toBe("app1");
    expect(calls[0]!.url).toBe("https://alpha.example.com/api/v1/app/status");
  });

  it("an account call (events, the list) needs no app, and an app named anyway is only a hint", async () => {
    const calls = stubServers({ "alpha.example.com": () => json({ apps: [] }) });
    const r = registryOf(SERVER_A);
    await r.clientFor(undefined, undefined, { account: true }).client.listApps();
    await r.clientFor(undefined, "app1", { account: true }).client.listApps();
    expect(calls[0]!.headers["X-Runway-App"]).toBeUndefined();
    expect(calls[1]!.headers["X-Runway-App"]).toBeUndefined();
  });

  it("a malformed app id is refused before anything is sent", () => {
    const calls = stubServers({});
    for (const bad of ["a b", "../x", "a\r\nX-Evil: 1", "x".repeat(65)]) {
      expect(() => registryOf(SERVER_A).clientFor(undefined, bad)).toThrow(/app id/);
    }
    expect(calls).toHaveLength(0);
  });

  it("a per-app key wins for its own app and is sent without an app header", async () => {
    const calls = stubServers({ "gamma.example.net": () => json({ app_id: "appxone" }) });
    const r = registryOf(SERVER_C);
    await r.clientFor("gamma", "appxone").client.getStatus();
    await r.clientFor("gamma", "appytwo").client.getStatus();
    expect(calls[0]!.headers.Authorization).toBe(`Bearer ${APP_KEY_X}`);
    expect(calls[1]!.headers.Authorization).toBe(`Bearer ${APP_KEY_Y}`);
    expect(calls[0]!.headers["X-Runway-App"]).toBeUndefined();
  });

  it("app keys only: an unknown app, or no app among several, is a clear question, not a guess", () => {
    const r = registryOf(SERVER_C);
    expect(() => r.clientFor("gamma", "appother")).toThrow(/no key for app 'appother'.*appxone, appytwo/);
    expect(() => r.clientFor("gamma", undefined)).toThrow(/several apps.*appxone, appytwo/);
  });

  it("app keys only, exactly one key: that app is the default", async () => {
    const calls = stubServers({ "solo.example.com": () => json({}) });
    const r = registryOf({ name: "solo", url: "https://solo.example.com", appKeys: { only: APP_KEY_X } });
    await r.clientFor("solo", undefined).client.getStatus();
    expect(calls[0]!.headers.Authorization).toBe(`Bearer ${APP_KEY_X}`);
  });

  it("a user token and an app key side by side: the key for that app, the token for the rest", async () => {
    const calls = stubServers({ "alpha.example.com": () => json({}) });
    const r = registryOf({ ...SERVER_A, appKeys: { appxone: APP_KEY_X } });
    await r.clientFor("alpha", "appxone").client.getStatus();
    await r.clientFor("alpha", "other").client.getStatus();
    expect(calls[0]!.headers.Authorization).toBe(`Bearer ${APP_KEY_X}`);
    expect(calls[1]!.headers.Authorization).toBe(`Bearer ${TOKEN_A}`);
    expect(calls[1]!.headers["X-Runway-App"]).toBe("other");
  });

  it("the old way: one app key, `app` is not used and nothing else is sent", async () => {
    const calls = stubServers({ "legacy.example.com": () => json({}) });
    const r = legacyRegistry();
    await r.clientFor(undefined, "ignored").client.getStatus();
    expect(calls[0]!.headers.Authorization).toBe(`Bearer ${APP_KEY_X}`);
    expect(calls[0]!.headers["X-Runway-App"]).toBeUndefined();
  });
});

describe("no federation: each call carries only its own server's credential", () => {
  it("every request goes to the base URL of its server with that server's token and nobody else's", async () => {
    const calls = stubServers({
      "alpha.example.com": () => json({ ok: 1 }),
      "beta.example.org": () => json({ ok: 2 }),
      "gamma.example.net": () => json({ ok: 3 }),
    });
    const r = registryOf(SERVER_A, SERVER_B, SERVER_C);
    await r.clientFor("alpha", "a1").client.getStatus();
    await r.clientFor("beta", "b1").client.getLogs();
    await r.clientFor("gamma", "appxone").client.getEnv();
    await r.clientFor("beta", "b1").client.deleteEnvVar("X");

    const byHost = (h: string) => calls.filter((c) => c.host === h);
    for (const c of byHost("alpha.example.com")) expect(c.headers.Authorization).toBe(`Bearer ${TOKEN_A}`);
    for (const c of byHost("beta.example.org")) expect(c.headers.Authorization).toBe(`Bearer ${TOKEN_B}`);
    for (const c of byHost("gamma.example.net")) expect(c.headers.Authorization).toBe(`Bearer ${APP_KEY_X}`);
    // Nothing leaked into a URL, and no request carried a second credential.
    for (const c of calls) {
      expect(c.url).not.toMatch(/rw[uy]_/);
      expect(Object.values(c.headers).join(" ").match(/rw[uy]_[A-Za-z0-9]+/g)).toHaveLength(1);
    }
  });

  it("knows every credential it holds, for masking", () => {
    const secrets = registryOf(SERVER_A, SERVER_C).secrets();
    expect(secrets).toEqual(expect.arrayContaining([TOKEN_A, APP_KEY_X, APP_KEY_Y]));
    expect(secrets).not.toContain(TOKEN_B);
    expect(legacyRegistry().secrets()).toEqual([APP_KEY_X]);
  });
});
