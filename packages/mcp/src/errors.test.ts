/**
 * S21, client side: a 429 is reported as "wait N seconds" and is never retried
 * in a loop, and no message carries a credential.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { describeApiError, parseRetryAfter, redactSecrets, RunwayApiError } from "./errors.js";
import { RunwayClient } from "./client.js";

const KEY = "rwy_abcdef1234567890SECRET";

afterEach(() => vi.unstubAllGlobals());

describe("parseRetryAfter", () => {
  it("reads seconds, clamps them and reads an HTTP date", () => {
    expect(parseRetryAfter("30")).toBe(30);
    expect(parseRetryAfter("0")).toBe(1);
    expect(parseRetryAfter("999999")).toBe(3600);
    expect(parseRetryAfter(null)).toBeUndefined();
    expect(parseRetryAfter("soon")).toBeUndefined();
    const now = Date.parse("2026-11-23T10:00:00Z");
    expect(parseRetryAfter("Mon, 23 Nov 2026 10:00:45 GMT", now)).toBe(45);
  });
});

describe("describeApiError", () => {
  it("tells the agent to wait on a 429, with the number of seconds", () => {
    const m = describeApiError(429, "{ignored}", { retryAfter: 42 });
    expect(m).toContain("rate limiting");
    expect(m).toContain("42 seconds");
    expect(m).toContain("do not retry in a loop");
    expect(m).not.toContain("ignored");
  });
  it("still gives advice when there is no Retry-After", () => {
    expect(describeApiError(429, "")).toContain("Wait a minute");
  });
  it("keeps the body for other errors but masks secrets and token shapes", () => {
    const m = describeApiError(401, `bad key ${KEY} and Bearer abcdefghijklmnop and rwd_zzzzzzzzzz`, {
      secrets: [KEY],
    });
    expect(m).toContain("Runway API error 401");
    expect(m).not.toContain("SECRET");
    expect(m).not.toContain("abcdefghijklmnop");
    expect(m).not.toContain("zzzzzzzzzz");
  });
  it("caps a long body", () => {
    expect(describeApiError(500, "x".repeat(5000)).length).toBeLessThan(1100);
  });
});

describe("redactSecrets", () => {
  it("ignores empty or very short secrets rather than blanking the text", () => {
    expect(redactSecrets("hello", ["", "ab"])).toBe("hello");
  });
});

describe("RunwayClient on a 429", () => {
  function client() {
    return new RunwayClient("https://runway.example.com", KEY);
  }
  function stub429() {
    const fetchMock = vi.fn(
      async () =>
        new Response(JSON.stringify({ error: `slow down ${KEY}` }), {
          status: 429,
          headers: { "Retry-After": "17" },
        })
    );
    vi.stubGlobal("fetch", fetchMock);
    return fetchMock;
  }

  it("throws once with the wait time, does not retry, and leaks no key", async () => {
    const fetchMock = stub429();
    const err = await client().getConfig().catch((e) => e);
    expect(err).toBeInstanceOf(RunwayApiError);
    expect(err.status).toBe(429);
    expect(err.retryAfter).toBe(17);
    expect(err.message).toContain("17 seconds");
    expect(err.message).not.toContain("SECRET");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("the deploy upload and the source download behave the same", async () => {
    const fetchMock = stub429();
    const c = client();
    const a = await c.deploy().catch((e) => e);
    const b = await c.pullSource().catch((e) => e);
    for (const e of [a, b]) {
      expect(e).toBeInstanceOf(RunwayApiError);
      expect(e.message).toContain("17 seconds");
      expect(e.message).not.toContain("SECRET");
    }
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("an ordinary error keeps its status and masks the key in the body", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(`nope ${KEY}`, { status: 403 }))
    );
    const err = await client().getConfig().catch((e) => e);
    expect(err.status).toBe(403);
    expect(err.message).toContain("Runway API error 403");
    expect(err.message).not.toContain("SECRET");
  });
});
