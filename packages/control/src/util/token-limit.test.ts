import { describe, expect, it } from "vitest";
import {
  classifyRequest,
  DEFAULT_LIMITS,
  FixedWindowCounter,
  HEAVY_ROUTES,
  limitsFromEnv,
  parseLimit,
} from "./token-limit.js";

const WIN = { limit: 3, windowMs: 60_000 };

describe("FixedWindowCounter", () => {
  it("allows up to the limit, then refuses with the seconds left", () => {
    const c = new FixedWindowCounter();
    const t = 1_000_000;
    expect(c.hit("a", WIN, t).allowed).toBe(true);
    expect(c.hit("a", WIN, t + 1000).remaining).toBe(1);
    expect(c.hit("a", WIN, t + 2000).remaining).toBe(0);
    const r = c.hit("a", WIN, t + 10_000);
    expect(r.allowed).toBe(false);
    expect(r.retryAfterSec).toBe(50);
  });

  it("starts over after the window", () => {
    const c = new FixedWindowCounter();
    for (let i = 0; i < 3; i++) c.hit("a", WIN, 0);
    expect(c.hit("a", WIN, 59_999).allowed).toBe(false);
    expect(c.hit("a", WIN, 60_000).allowed).toBe(true);
  });

  it("keeps keys independent: a noisy one does not use up another's allowance", () => {
    const c = new FixedWindowCounter();
    for (let i = 0; i < 10; i++) c.hit("noisy", WIN, 0);
    expect(c.hit("noisy", WIN, 0).allowed).toBe(false);
    expect(c.hit("quiet", WIN, 0).allowed).toBe(true);
  });

  it("never reports less than one second to wait", () => {
    const c = new FixedWindowCounter();
    for (let i = 0; i < 3; i++) c.hit("a", WIN, 0);
    expect(c.hit("a", WIN, 59_999).retryAfterSec).toBe(1);
  });

  it("record() counts without refusing and blocked() does not count", () => {
    const c = new FixedWindowCounter();
    for (let i = 0; i < 5; i++) c.record("ip", WIN, 0);
    expect(c.blocked("ip", WIN, 1000).allowed).toBe(false);
    expect(c.blocked("ip", WIN, 1000).retryAfterSec).toBe(59);
    expect(c.blocked("other", WIN, 0).allowed).toBe(true);
    // Looking is free: asking 100 times changes nothing.
    for (let i = 0; i < 100; i++) c.blocked("other", WIN, 0);
    expect(c.blocked("other", WIN, 0).remaining).toBe(3);
    // And the block ends with the window.
    expect(c.blocked("ip", WIN, 60_000).allowed).toBe(true);
  });

  it("stays bounded: expired entries go first, then the oldest", () => {
    const c = new FixedWindowCounter(100);
    for (let i = 0; i < 100; i++) c.hit(`old${i}`, WIN, 0);
    expect(c.size).toBe(100);
    // All expired by now: a new key sweeps them.
    c.hit("new", WIN, 120_000);
    expect(c.size).toBe(1);
    // Live entries only: the cap still holds and the oldest is forgotten.
    const d = new FixedWindowCounter(50);
    for (let i = 0; i < 500; i++) d.hit(`k${i}`, WIN, 1000 + i);
    expect(d.size).toBeLessThanOrEqual(50);
    expect(d.hit("k499", WIN, 2000).remaining).toBe(1); // newest survived
  });

  it("sweep() drops only what has expired", () => {
    const c = new FixedWindowCounter();
    c.hit("a", { limit: 1, windowMs: 1000 }, 0);
    c.hit("b", { limit: 1, windowMs: 100_000 }, 0);
    expect(c.sweep(5000)).toBe(1);
    expect(c.size).toBe(1);
  });
});

describe("classifyRequest", () => {
  it("reads, writes and the heavy routes", () => {
    expect(classifyRequest("GET", "/api/v1/app")).toBe("read");
    expect(classifyRequest("GET", "/api/v1/app/status")).toBe("read");
    expect(classifyRequest("PUT", "/api/v1/app/env")).toBe("write");
    expect(classifyRequest("DELETE", "/api/v1/app/env/FOO")).toBe("write");
    expect(classifyRequest("POST", "/api/v1/app/deploy")).toBe("heavy");
    expect(classifyRequest("POST", "/api/v1/app/rollback")).toBe("heavy");
    expect(classifyRequest("GET", "/api/v1/app/source")).toBe("heavy");
  });
  it("a trailing slash or a lower-case method does not sidestep the heavy bucket", () => {
    expect(classifyRequest("post", "/api/v1/app/deploy/")).toBe("heavy");
    expect(classifyRequest("GET", "/api/v1/app/source//")).toBe("heavy");
  });
  it("an unknown mutating route is a write, never a free read", () => {
    expect(classifyRequest("POST", "/api/v1/app/whatever")).toBe("write");
    expect(classifyRequest("PATCH", "/api/v1/app/x")).toBe("write");
  });
  it("lists a small, known set as heavy", () => {
    expect(HEAVY_ROUTES.size).toBe(5);
  });
});

describe("limits from the environment", () => {
  it("uses the defaults when nothing is set", () => {
    expect(limitsFromEnv({})).toEqual(DEFAULT_LIMITS);
    expect(DEFAULT_LIMITS.read.limit).toBe(120);
    expect(DEFAULT_LIMITS.write.limit).toBe(60);
    expect(DEFAULT_LIMITS.heavy).toEqual({ limit: 10, windowMs: 600_000 });
    expect(DEFAULT_LIMITS.authFail).toEqual({ limit: 20, windowMs: 600_000 });
  });
  it("reads overrides and ignores nonsense", () => {
    const l = limitsFromEnv({
      RATE_LIMIT_READ_PER_MIN: "500",
      RATE_LIMIT_WRITE_PER_MIN: "abc",
      RATE_LIMIT_HEAVY_PER_10MIN: "0",
      RATE_LIMIT_AUTH_FAIL_PER_10MIN: "-3",
    });
    expect(l.read.limit).toBe(500);
    expect(l.write.limit).toBe(60);
    expect(l.heavy.limit).toBe(10);
    expect(l.authFail.limit).toBe(20);
  });
  it("parseLimit caps a typo so the limit cannot be switched off", () => {
    expect(parseLimit("99999999999", 5)).toBe(100_000);
    expect(parseLimit(" 7 ", 5)).toBe(7);
    expect(parseLimit("1e3", 5)).toBe(5);
    expect(parseLimit("", 5)).toBe(5);
    expect(parseLimit(undefined, 5)).toBe(5);
  });
});
