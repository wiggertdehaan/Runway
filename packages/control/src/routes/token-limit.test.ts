/**
 * S21: allowances per key on the API and /mcp, and a cap on wrong key guesses
 * per source. Drives the real app against an in-memory database.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { app } from "../app.js";
import { db, migrate } from "../db/index.js";
import { createApp } from "../db/apps.js";
import { createDevToken } from "../db/dev-tokens.js";
import { createUser } from "../db/users.js";
import { setSetting } from "../db/settings.js";
import { apiAuth } from "../middleware/auth.js";
import { apiAudit } from "../middleware/api-audit.js";
import { apiAuthorize } from "../middleware/api-authorize.js";
import {
  apiTokenLimit,
  resetTokenLimits,
  sweepTokenLimits,
  tokenLimitSizes,
} from "../middleware/token-limit.js";
import { HEAVY_ROUTES } from "../util/token-limit.js";

const ENV_KEYS = [
  "RATE_LIMIT_READ_PER_MIN",
  "RATE_LIMIT_WRITE_PER_MIN",
  "RATE_LIMIT_HEAVY_PER_10MIN",
  "RATE_LIMIT_AUTH_FAIL_PER_10MIN",
  "API_IP_RATE_LIMIT",
];

let a = { id: "", key: "" };
let b = { id: "", key: "" };

beforeAll(() => {
  migrate();
  process.env.DASHBOARD_DOMAIN = "runway.example.com";
});

beforeEach(() => {
  db.exec("DELETE FROM audit_log");
  db.exec("DELETE FROM apps");
  try {
    db.exec("DELETE FROM rate_limits");
  } catch {
    /* created on first use */
  }
  resetTokenLimits();
  setSetting("base_domain", "example.com");
  const one = createApp("alice");
  const two = createApp("bob");
  a = { id: one.id, key: one.api_key };
  b = { id: two.id, key: two.api_key };
});

afterEach(() => {
  for (const k of ENV_KEYS) delete process.env[k];
});

function get(key: string, path = "/app", headers: Record<string, string> = {}) {
  return app.request(`/api/v1${path}`, {
    headers: { authorization: `Bearer ${key}`, ...headers },
  });
}

function put(key: string, path: string, body: unknown) {
  return app.request(`/api/v1${path}`, {
    method: "PUT",
    headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

function audit(where = "1=1") {
  return db.prepare(`SELECT * FROM audit_log WHERE ${where} ORDER BY id`).all() as Array<
    Record<string, any>
  >;
}

describe("the limiter is in place", () => {
  it("sits right after the key check, before the scope check and the audit middleware", () => {
    const handlers = app.routes.filter((r) => r.path === "/api/v1/*").map((r) => r.handler);
    const auth = handlers.indexOf(apiAuth);
    expect(auth).toBeGreaterThanOrEqual(0);
    expect(handlers.indexOf(apiTokenLimit)).toBe(auth + 1);
    expect(handlers.indexOf(apiAuthorize)).toBe(auth + 2);
    expect(handlers.indexOf(apiAudit)).toBe(auth + 3);
  });

  it("every heavy route is still a real route (no stale entry)", () => {
    const routes = new Set(app.routes.map((r) => `${r.method} ${r.path}`));
    for (const h of HEAVY_ROUTES) expect(routes.has(h), `${h} is not a route`).toBe(true);
  });
});

describe("per-key buckets", () => {
  it("refuses a key over its read allowance with 429 and Retry-After, and says nothing internal", async () => {
    process.env.RATE_LIMIT_READ_PER_MIN = "5";
    for (let i = 0; i < 5; i++) expect((await get(a.key)).status).toBe(200);
    const res = await get(a.key);
    expect(res.status).toBe(429);
    const wait = Number(res.headers.get("retry-after"));
    expect(wait).toBeGreaterThanOrEqual(1);
    expect(wait).toBeLessThanOrEqual(60);
    const body = await res.json();
    expect(body.retry_after).toBe(wait);
    const text = JSON.stringify(body);
    expect(text).not.toContain(a.id);
    expect(text).not.toContain("bucket");
    expect(text).not.toContain("read");
  });

  it("a noisy key does not use up another key's allowance", async () => {
    process.env.RATE_LIMIT_READ_PER_MIN = "3";
    for (let i = 0; i < 6; i++) await get(a.key);
    expect((await get(a.key)).status).toBe(429);
    expect((await get(b.key)).status).toBe(200);
  });

  it("reads, writes and heavy actions have their own buckets", async () => {
    process.env.RATE_LIMIT_READ_PER_MIN = "2";
    process.env.RATE_LIMIT_WRITE_PER_MIN = "2";
    process.env.RATE_LIMIT_HEAVY_PER_10MIN = "2";
    for (let i = 0; i < 3; i++) await get(a.key);
    expect((await get(a.key)).status).toBe(429);
    // Reads are used up; a write and a heavy action still go through to their handlers.
    expect((await put(a.key, "/app/scan-threshold", { scan_threshold: "high" })).status).not.toBe(429);
    expect((await get(a.key, "/app/source")).status).not.toBe(429);
    expect((await get(a.key, "/app/source")).status).not.toBe(429);
    expect((await get(a.key, "/app/source")).status).toBe(429);
    // ... and the write bucket is separate from both.
    expect((await put(a.key, "/app/scan-threshold", { scan_threshold: "high" })).status).not.toBe(429);
    expect((await put(a.key, "/app/scan-threshold", { scan_threshold: "high" })).status).toBe(429);
  });

  it("deploy is heavy: a third deploy in the window is refused before it does any work", async () => {
    process.env.RATE_LIMIT_HEAVY_PER_10MIN = "2";
    const deploy = () =>
      app.request("/api/v1/app/deploy", {
        method: "POST",
        headers: { authorization: `Bearer ${a.key}`, "content-type": "application/json" },
        body: "{}",
      });
    expect((await deploy()).status).not.toBe(429); // 409 (not configured): the handler ran
    expect((await deploy()).status).not.toBe(429);
    const third = await deploy();
    expect(third.status).toBe(429);
    expect(Number(third.headers.get("retry-after"))).toBeGreaterThan(60); // a ten-minute window
  });

  it("a refusal is one counted audit row with the key's id, not one line per refusal", async () => {
    process.env.RATE_LIMIT_READ_PER_MIN = "2";
    for (let i = 0; i < 12; i++) await get(a.key);
    const rows = audit("action = 'api_token_rate_limited'");
    expect(rows).toHaveLength(1);
    expect(rows[0]!.count).toBe(10);
    expect(rows[0]!.result).toBe("denied");
    expect(rows[0]!.detail).toBe(`reason=actor=api-key:${a.id} bucket=read`);
    expect(JSON.stringify(audit())).not.toContain(a.key);
    // The refused calls are not also written as ordinary API lines.
    expect(audit("action LIKE 'api_%' AND result = 'ok'")).toHaveLength(0);
  });

  it("starts over when the window is over (the counter forgets expired entries)", () => {
    sweepTokenLimits();
    expect(tokenLimitSizes().tokens).toBe(0);
  });
});

describe("wrong key guesses", () => {
  it("blocks a source after too many wrong keys, even for a correct key, and audits it once", async () => {
    process.env.RATE_LIMIT_AUTH_FAIL_PER_10MIN = "5";
    for (let i = 0; i < 5; i++) expect((await get(`rwy_guess${i}`)).status).toBe(401);
    const blocked = await get(a.key);
    expect(blocked.status).toBe(429);
    expect(Number(blocked.headers.get("retry-after"))).toBeGreaterThan(60);
    await get("rwy_another");
    const rows = audit("action = 'auth_guess_blocked'");
    expect(rows).toHaveLength(1);
    expect(rows[0]!.count).toBe(2);
    expect(JSON.stringify(audit())).not.toContain("rwy_guess");
  });

  it("a missing header is not a guess and cannot lock an address out", async () => {
    process.env.RATE_LIMIT_AUTH_FAIL_PER_10MIN = "3";
    for (let i = 0; i < 10; i++) expect((await app.request("/api/v1/app")).status).toBe(401);
    expect((await get(a.key)).status).toBe(200);
  });

  it("a correct key does not count as a guess", async () => {
    process.env.RATE_LIMIT_AUTH_FAIL_PER_10MIN = "3";
    for (let i = 0; i < 10; i++) expect((await get(a.key)).status).toBe(200);
  });

  it("applies to /mcp too, with the same counter", async () => {
    process.env.RATE_LIMIT_AUTH_FAIL_PER_10MIN = "3";
    for (let i = 0; i < 2; i++) {
      const r = await app.request("/mcp", { method: "POST", headers: { authorization: "Bearer rwd_nope" } });
      expect(r.status).toBe(401);
    }
    await get("rwy_wrong"); // third wrong key, through the API this time
    const r = await app.request("/mcp", { method: "POST", headers: { authorization: "Bearer rwd_nope" } });
    expect(r.status).toBe(429);
    expect(audit("action = 'auth_guess_blocked'")[0]!.actor_type).toBe("mcp");
  });
});

describe("/mcp tokens", () => {
  it("count per token id, and a refusal names the id, never the token", async () => {
    process.env.RATE_LIMIT_READ_PER_MIN = "2";
    const user = await createUser("carol", "pw-for-test-only-123456", "member");
    const t1 = createDevToken(user.id, "laptop");
    const t2 = createDevToken(user.id, "ci");
    const call = (token: string) =>
      app.request("/mcp", {
        method: "POST",
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
        },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" }),
      });
    for (let i = 0; i < 2; i++) expect((await call(t1.token)).status).not.toBe(429);
    const refused = await call(t1.token);
    expect(refused.status).toBe(429);
    expect(refused.headers.get("retry-after")).toBeTruthy();
    expect((await call(t2.token)).status).not.toBe(429);
    const rows = audit("action = 'api_token_rate_limited'");
    expect(rows).toHaveLength(1);
    expect(rows[0]!.actor_type).toBe("mcp");
    expect(rows[0]!.detail).toContain(`mcp-token:${t1.id}`);
    expect(JSON.stringify(rows)).not.toContain(t1.token);
  });
});

describe("the per-IP flood guard", () => {
  it("is generous by default (an office is many people) and still adjustable", async () => {
    // Many different keys from one address are fine at the default...
    process.env.RATE_LIMIT_READ_PER_MIN = "1000";
    for (let i = 0; i < 70; i++) expect((await get(a.key)).status).toBe(200);
    // ... and an operator can tighten it. It also answers with Retry-After.
    process.env.API_IP_RATE_LIMIT = "75";
    let last = 200;
    let retry: string | null = null;
    for (let i = 0; i < 10; i++) {
      const r = await get(a.key);
      last = r.status;
      retry = r.headers.get("retry-after");
      if (last === 429) break;
    }
    expect(last).toBe(429);
    expect(Number(retry)).toBeGreaterThanOrEqual(1);
  });
});
