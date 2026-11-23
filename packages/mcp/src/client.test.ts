/**
 * Step 14, client side: a request only ever goes to its own base URL, a
 * redirect is never followed (so the Authorization header cannot be replayed
 * at another host), a slow server ends in a timeout, and no failure message
 * carries the credential.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { RunwayClient } from "./client.js";
import { RunwayApiError } from "./errors.js";
import { TOKEN_A, json, stubServers } from "./testkit.js";

afterEach(() => vi.unstubAllGlobals());

/** The error a call ends in; fails the test if the call succeeds. */
const failure = (p: Promise<unknown>): Promise<RunwayApiError> =>
  p.then(
    () => {
      throw new Error("expected the call to fail");
    },
    (e: unknown) => e as RunwayApiError
  );

describe("redirects", () => {
  it("are not followed: a 302 to another host is an error and the second host never sees a request", async () => {
    const calls = stubServers({
      "alpha.example.com": () =>
        new Response(null, { status: 302, headers: { location: "https://evil.example.net/steal" } }),
      "evil.example.net": () => json({ got: "it" }),
    });
    const err = await failure(new RunwayClient("https://alpha.example.com", TOKEN_A).getStatus());
    expect(err).toBeInstanceOf(RunwayApiError);
    expect(err.message).toMatch(/redirect/i);
    expect(err.message).not.toContain(TOKEN_A);
    expect(err.message).not.toContain("evil.example.net");
    expect(calls.map((c) => c.host)).toEqual(["alpha.example.com"]);
    expect(calls[0]!.init.redirect).toBe("manual");
  });

  it("every kind of call refuses to follow one (deploy, source download, event detail)", async () => {
    stubServers({ "alpha.example.com": () => new Response(null, { status: 307, headers: { location: "https://evil.example.net/" } }) });
    const c = new RunwayClient("https://alpha.example.com", TOKEN_A);
    for (const call of [() => c.deploy(), () => c.pullSource(), () => c.getEventDetail("c1_a"), () => c.getMe()]) {
      await expect(call()).rejects.toThrow(/redirect/i);
    }
    expect((fetch as unknown as ReturnType<typeof vi.fn>).mock.calls.every((x) => (x[1] as RequestInit).redirect === "manual")).toBe(true);
  });
});

describe("timeouts and a network that fails", () => {
  it("passes a time limit to every request", async () => {
    const calls = stubServers({ "alpha.example.com": () => json({}) });
    await new RunwayClient("https://alpha.example.com", TOKEN_A).getStatus();
    expect(calls[0]!.init.signal).toBeInstanceOf(AbortSignal);
  });

  it("a server that does not answer ends in a plain message", async () => {
    stubServers({ "alpha.example.com": () => Object.assign(new Error("The operation was aborted due to timeout"), { name: "TimeoutError" }) });
    const err = await failure(new RunwayClient("https://alpha.example.com", TOKEN_A, { timeoutMs: 5000 }).getStatus());
    expect(err).toBeInstanceOf(RunwayApiError);
    expect(err.status).toBe(0);
    expect(err.message).toMatch(/did not answer within 5 seconds/);
  });

  it("a network failure names the reason code, not the url, the cause chain or the token", async () => {
    stubServers({
      "alpha.example.com": () =>
        Object.assign(new TypeError(`fetch failed ${TOKEN_A}`), { cause: { code: "ECONNREFUSED", message: `connect to https://alpha.example.com with ${TOKEN_A}` } }),
    });
    const err = await failure(new RunwayClient("https://alpha.example.com", TOKEN_A).getStatus());
    expect(err.status).toBe(0);
    expect(err.message).toBe("Could not reach the Runway server (ECONNREFUSED).");
    expect(err.message).not.toContain(TOKEN_A);
  });

  it("an odd cause code is not trusted into the message", async () => {
    stubServers({ "alpha.example.com": () => Object.assign(new TypeError("x"), { cause: { code: `weird ${TOKEN_A}` } }) });
    const err = await failure(new RunwayClient("https://alpha.example.com", TOKEN_A).getStatus());
    expect(err.message).toBe("Could not reach the Runway server (network error).");
  });
});

describe("what a request carries", () => {
  it("sends the app only when it was given, and never puts the token in a URL", async () => {
    const calls = stubServers({ "alpha.example.com": () => json({ events: [], next_cursor: "c1_0", has_more: false }) });
    await new RunwayClient("https://alpha.example.com", TOKEN_A, { app: "app1" }).getStatus();
    await new RunwayClient("https://alpha.example.com", TOKEN_A).getEvents("c1_a", 5, "app1");
    expect(calls[0]!.headers["X-Runway-App"]).toBe("app1");
    expect(calls[1]!.headers["X-Runway-App"]).toBeUndefined();
    expect(calls[1]!.path).toBe("/api/v1/events?since=c1_a&limit=5&app=app1");
    for (const c of calls) expect(c.url).not.toContain(TOKEN_A);
  });

  it("the new calls use the routes the server offers for user tokens", async () => {
    const calls = stubServers({ "alpha.example.com": () => json({}) });
    const c = new RunwayClient("https://alpha.example.com", TOKEN_A, { app: "app1" });
    await c.getMe();
    await c.listApps();
    await c.createApp();
    await c.rebuild();
    await c.rescan();
    expect(calls.map((x) => `${x.method} ${x.path}`)).toEqual([
      "GET /api/v1/me",
      "GET /api/v1/apps",
      "POST /api/v1/apps",
      "POST /api/v1/app/rebuild",
      "POST /api/v1/app/rescan",
    ]);
  });

  it("a body that is not JSON is reported as that, without quoting any of it (the parser's own message does)", async () => {
    stubServers({ "alpha.example.com": () => new Response(`${TOKEN_A.slice(0, 12)} <html>gateway error</html>`, { status: 200 }) });
    const err = await failure(new RunwayClient("https://alpha.example.com", TOKEN_A).getMe());
    expect(err).toBeInstanceOf(RunwayApiError);
    expect(err.message).toMatch(/not JSON/);
    expect(err.message).not.toContain("rwu_");
    expect(err.message).not.toContain("Unexpected");
    expect(err.message).not.toContain("gateway");
  });

  it("a 401 with the token echoed in the body is masked", async () => {
    stubServers({ "alpha.example.com": () => new Response(`bad token ${TOKEN_A}`, { status: 401 }) });
    const err = await failure(new RunwayClient("https://alpha.example.com", TOKEN_A).getMe());
    expect(err.status).toBe(401);
    expect(err.message).not.toContain(TOKEN_A);
  });
});
