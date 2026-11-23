/**
 * S19: /setup hands out the first admin account, so until that account exists
 * it needs a one-time token that only whoever installed Runway has seen.
 * Drives the real app against an in-memory database with no users.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { app } from "../app.js";
import { db, migrate } from "../db/index.js";
import { countUsers } from "../db/users.js";
import { getSetting, setSetting } from "../db/settings.js";
import {
  MIN_ENV_TOKEN_LENGTH,
  currentSetupToken,
  generateSetupToken,
  setupTokenAnnouncement,
  setupTokenMatches,
} from "../auth/setup-token.js";

const CSRF = "test-csrf-token";

beforeAll(() => {
  migrate();
});

beforeEach(() => {
  try {
    db.exec("DELETE FROM rate_limits");
  } catch {
    /* table is created on first use */
  }
});

afterEach(() => {
  delete process.env.SETUP_TOKEN;
});

function postSetup(fields: Record<string, string>, csrf = true) {
  const body = new URLSearchParams(fields);
  if (csrf) body.set("_csrf", CSRF);
  return app.request("/setup", {
    method: "POST",
    headers: {
      cookie: csrf ? `runway_csrf=${CSRF}` : "",
      "content-type": "application/x-www-form-urlencoded",
    },
    body: body.toString(),
  });
}
const loc = (r: Response) => r.headers.get("location");
const good = { username: "root", password: "pw-root-123456" };

describe("while no admin exists", () => {
  it("the setup form asks for the token and never contains it", async () => {
    const token = currentSetupToken()!.token;
    const html = await (await app.request("/setup")).text();
    expect(html).toContain('name="setup_token"');
    expect(html).toContain("grep -i");
    expect(html).not.toContain(token);
  });

  it("generates a token once and keeps it across calls (and restarts)", () => {
    const a = currentSetupToken()!;
    const b = currentSetupToken()!;
    expect(a.source).toBe("generated");
    expect(a.token).toMatch(/^rws_[A-Za-z0-9_-]{30,}$/);
    expect(b.token).toBe(a.token);
    expect(getSetting("setup_token")).toBe(a.token);
  });

  it("refuses a request with no token, and creates nobody", async () => {
    const r = await postSetup({ ...good });
    expect(loc(r)).toBe("/setup?error=token");
    expect(countUsers()).toBe(0);
  });

  it("refuses a wrong token, and creates nobody", async () => {
    const r = await postSetup({ ...good, setup_token: "rws_not-the-token-at-all-0000" });
    expect(loc(r)).toBe("/setup?error=token");
    expect(countUsers()).toBe(0);
  });

  it("an empty or whitespace token never matches", async () => {
    for (const t of ["", "   "]) {
      const r = await postSetup({ ...good, setup_token: t });
      expect(loc(r)).toBe("/setup?error=token");
    }
    expect(countUsers()).toBe(0);
  });

  it("the token never appears in a redirect or a failure page", async () => {
    const token = currentSetupToken()!.token;
    const r = await postSetup({ ...good, setup_token: "wrong-wrong-wrong-wrong" });
    expect(loc(r) ?? "").not.toContain(token);
    const page = await (await app.request("/setup?error=token")).text();
    expect(page).not.toContain(token);
    expect(page).toContain("That setup token is not right.");
  });

  it("rejects a request without the CSRF token", async () => {
    const token = currentSetupToken()!.token;
    const r = await postSetup({ ...good, setup_token: token }, false);
    expect(r.status).toBe(403);
    expect(countUsers()).toBe(0);
  });

  it("locks out an address after five wrong guesses, even for the right token", async () => {
    const token = currentSetupToken()!.token;
    for (let i = 0; i < 5; i++) {
      expect(loc(await postSetup({ ...good, setup_token: `guess-${i}-xxxxxxxxxxxxxxxx` }))).toBe("/setup?error=token");
    }
    const r = await postSetup({ ...good, setup_token: token });
    expect(loc(r)).toBe("/setup?error=wait");
    expect(countUsers()).toBe(0);
    const page = await (await app.request("/setup?error=wait")).text();
    expect(page).toContain("Too many attempts");
  });

  it("also caps wrong guesses for the whole server", async () => {
    const token = currentSetupToken()!.token;
    const now = Date.now();
    db.prepare(`INSERT OR REPLACE INTO rate_limits (key, count, first_attempt, updated_at) VALUES ('login:setup:all', 30, ?, ?)`).run(now, now);
    const r = await postSetup({ ...good, setup_token: token });
    expect(loc(r)).toBe("/setup?error=wait");
    expect(countUsers()).toBe(0);
  });

  it("an environment token wins over the stored one, and a short one is ignored", async () => {
    const stored = currentSetupToken()!.token;
    process.env.SETUP_TOKEN = "env-token-0123456789-abcdef";
    expect(currentSetupToken()).toEqual({ token: "env-token-0123456789-abcdef", source: "env" });
    // the generated token no longer works while an environment token is set
    expect(loc(await postSetup({ ...good, setup_token: stored }))).toBe("/setup?error=token");
    process.env.SETUP_TOKEN = "short";
    expect(currentSetupToken()!.source).toBe("generated");
    expect(currentSetupToken()!.token).toBe(stored);
    expect(MIN_ENV_TOKEN_LENGTH).toBe(16);
  });

  it("announces the token in the log lines, and warns about a short one", () => {
    const token = currentSetupToken()!.token;
    const lines = setupTokenAnnouncement({ DASHBOARD_DOMAIN: "runway.example.com" } as NodeJS.ProcessEnv);
    expect(lines).toContain(`Setup token: ${token}`);
    expect(lines.join("\n")).toContain("https://runway.example.com/setup");
    const warn = setupTokenAnnouncement({ SETUP_TOKEN: "short" } as NodeJS.ProcessEnv);
    expect(warn[0]).toContain("shorter than 16");
  });

  it("login still sends a visitor to setup", async () => {
    const r = await app.request("/login");
    expect(loc(r)).toBe("/setup");
  });
});

describe("the right token creates the first admin, once", () => {
  it("creates the account, starts a session and forgets the token", async () => {
    const token = currentSetupToken()!.token;
    const r = await postSetup({ ...good, setup_token: token, base_domain: "runway.example.com" });
    expect(loc(r)).toBe("/?welcome=1");
    expect(countUsers()).toBe(1);
    expect(r.headers.get("set-cookie") ?? "").toMatch(/session/);
    expect(getSetting("setup_token")).toBeUndefined();
    expect(getSetting("base_domain")).toBe("runway.example.com");
  });

  it("then closes /setup for good, token or not", async () => {
    expect(currentSetupToken()).toBeNull();
    expect(loc(await app.request("/setup"))).toBe("/login");
    const again = await postSetup({ username: "intruder", password: "pw-intruder-1234", setup_token: "anything-at-all-0000" });
    expect(loc(again)).toBe("/login");
    expect(countUsers()).toBe(1);
  });

  it("an existing installation with a stored leftover token drops it and says nothing", () => {
    setSetting("setup_token", "rws_left-over");
    expect(currentSetupToken()).toBeNull();
    expect(getSetting("setup_token")).toBeUndefined();
    expect(setupTokenAnnouncement({} as NodeJS.ProcessEnv)).toEqual([]);
  });
});

describe("helpers", () => {
  it("setupTokenMatches is exact, trims input, and survives different lengths", () => {
    const t = generateSetupToken();
    expect(setupTokenMatches(t, t)).toBe(true);
    expect(setupTokenMatches(`  ${t}\n`, t)).toBe(true);
    expect(setupTokenMatches(t.slice(0, -1), t)).toBe(false);
    expect(setupTokenMatches(`${t}x`, t)).toBe(false);
    expect(setupTokenMatches("a", t)).toBe(false);
    expect(setupTokenMatches(undefined, t)).toBe(false);
    expect(setupTokenMatches(null, t)).toBe(false);
    expect(setupTokenMatches("", "")).toBe(false);
  });

  it("generated tokens are long and unique", () => {
    const seen = new Set(Array.from({ length: 50 }, () => generateSetupToken()));
    expect(seen.size).toBe(50);
    for (const t of seen) expect(t.length).toBeGreaterThanOrEqual(30);
  });
});
