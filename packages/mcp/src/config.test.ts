/**
 * Step 14: which servers the client talks to. The config is checked hard (a
 * typo must not silently become "no token") and says nothing of any value.
 */
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  ConfigError,
  LEGACY_MISSING_MESSAGE,
  loadRunwayConfig,
  normalizeServerUrl,
  parseConfig,
  permissionWarning,
} from "./config.js";

const TOKEN_A = "rwu_AAAAAAAAAAAAAAAAAAAAAAAAAAAA1";
const TOKEN_B = "rwu_BBBBBBBBBBBBBBBBBBBBBBBBBBBB2";
const APP_KEY = "rwy_KKKKKKKKKKKKKKKKKKKKKKKKKKKK3";

function server(extra: Record<string, unknown> = {}) {
  return { name: "wiggert", url: "https://runway.example.com", token: TOKEN_A, ...extra };
}

describe("parseConfig", () => {
  it("reads several servers, strips the trailing slash and keeps app keys apart from the token", () => {
    const servers = parseConfig({
      runways: [
        server({ url: "https://runway.example.com/" }),
        { name: "wsv", url: "https://apps.example.org", token: TOKEN_B },
        { name: "small", url: "https://small.example.net", app_keys: { abc123: APP_KEY } },
      ],
    });
    expect(servers.map((s) => s.name)).toEqual(["wiggert", "wsv", "small"]);
    expect(servers[0]!.url).toBe("https://runway.example.com");
    expect(servers[0]!.token).toBe(TOKEN_A);
    expect(servers[2]!.token).toBeUndefined();
    expect(servers[2]!.appKeys).toEqual({ abc123: APP_KEY });
  });

  it("takes the token from the environment variable it names, and says which one is missing, never a value", () => {
    const cfg = { runways: [{ name: "roamler", url: "https://r.example.com", token_env: "RUNWAY_TOKEN_ROAMLER" }] };
    expect(parseConfig(cfg, { RUNWAY_TOKEN_ROAMLER: TOKEN_B })[0]!.token).toBe(TOKEN_B);
    expect(() => parseConfig(cfg, {})).toThrow(/RUNWAY_TOKEN_ROAMLER/);
    expect(() => parseConfig(cfg, { RUNWAY_TOKEN_ROAMLER: "  " })).toThrow(/not set/);
  });

  it("refuses a field it does not know instead of ignoring it (a typo must not become 'no token')", () => {
    expect(() => parseConfig({ runways: [server({ tokne: TOKEN_B })] })).toThrow(/unknown field.*tokne/i);
    expect(() => parseConfig({ runways: [server()], extra: 1 })).toThrow(/Unknown field/);
  });

  it("needs unique, well-formed names", () => {
    expect(() => parseConfig({ runways: [server(), server()] })).toThrow(/unique/);
    for (const name of ["", "Wiggert", "has space", "-lead", "x".repeat(33)]) {
      expect(() => parseConfig({ runways: [server({ name })] })).toThrow(/"name"/);
    }
    expect(() => parseConfig({ runways: [{ url: "https://x.example.com", token: TOKEN_A }] })).toThrow(/"name"/);
  });

  it("needs some credential, but not two ways of giving the same one", () => {
    expect(() => parseConfig({ runways: [{ name: "a", url: "https://a.example.com" }] })).toThrow(/needs a "token"/);
    expect(() => parseConfig({ runways: [server({ token_env: "X" })] })).toThrow(/either "token" or "token_env"/);
    expect(() => parseConfig({ runways: [server({ app_keys: {} , token: undefined, name: "a" })] })).toThrow(/needs a "token"/);
  });

  it("tells a per-app key from a user token and says where each belongs", () => {
    expect(() => parseConfig({ runways: [server({ token: APP_KEY })] })).toThrow(/app_keys/);
    expect(() => parseConfig({ runways: [server({ token: "nonsense" })] })).toThrow(/rwu_/);
  });

  it("validates app keys", () => {
    expect(() => parseConfig({ runways: [server({ app_keys: { "bad id!": APP_KEY } })] })).toThrow(/not a valid app id/);
    expect(() => parseConfig({ runways: [server({ app_keys: { abc: "" } })] })).toThrow(/non-empty/);
    expect(() => parseConfig({ runways: [server({ app_keys: [] })] })).toThrow(/object/);
  });

  it("rejects an empty or malformed top level", () => {
    for (const bad of [null, [], "x", {}, { runways: [] }, { runways: "x" }, { runways: [1] }]) {
      expect(() => parseConfig(bad)).toThrow(ConfigError);
    }
  });
});

describe("normalizeServerUrl", () => {
  it("wants https, except for the machine itself or an explicit allow_insecure", () => {
    expect(normalizeServerUrl("https://r.example.com/", "a", false)).toBe("https://r.example.com");
    expect(() => normalizeServerUrl("http://r.example.com", "a", false)).toThrow(/https/);
    expect(normalizeServerUrl("http://r.example.com", "a", true)).toBe("http://r.example.com");
    for (const local of ["http://localhost:3000", "http://127.0.0.1:3000", "http://[::1]:3000", "http://dev.localhost"]) {
      expect(normalizeServerUrl(local, "a", false)).toBe(local);
    }
    expect(() => normalizeServerUrl("ftp://r.example.com", "a", true)).toThrow(/https/);
  });

  it("refuses a credential, a query or a fragment in the url", () => {
    expect(() => normalizeServerUrl("https://user:pw@r.example.com", "a", false)).toThrow(/user name or password/);
    expect(() => normalizeServerUrl("https://r.example.com/?token=x", "a", false)).toThrow(/query/);
    expect(() => normalizeServerUrl("https://r.example.com/#x", "a", false)).toThrow(/query or a fragment/);
    expect(() => normalizeServerUrl("not a url", "a", false)).toThrow(/valid URL/);
  });
});

describe("loadRunwayConfig", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "runway-mcp-cfg-"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  function write(content: string, mode = 0o600): string {
    const p = join(dir, "config.json");
    writeFileSync(p, content);
    chmodSync(p, mode);
    return p;
  }

  it("without a file or token it is the old way: RUNWAY_URL + RUNWAY_APP_KEY, one app key, not validated further", () => {
    const home = { HOME: dir, USERPROFILE: dir };
    const c = loadRunwayConfig({ ...home, RUNWAY_URL: "http://runway.internal/", RUNWAY_APP_KEY: APP_KEY, RUNWAY_CONFIG: undefined });
    expect(c.mode).toBe("legacy");
    expect(c.servers).toHaveLength(1);
    expect(c.servers[0]).toMatchObject({ name: "default", url: "http://runway.internal", legacyKey: APP_KEY });
    expect(c.servers[0]!.token).toBeUndefined();
  });

  it("without anything it fails with the old message", () => {
    expect(() => loadRunwayConfig({ RUNWAY_CONFIG: join(dir, "missing-but-default"), HOME: dir })).toThrow(/no such file/);
    expect(() => loadRunwayConfig({ HOME: dir, USERPROFILE: dir })).toThrow(LEGACY_MISSING_MESSAGE);
    expect(LEGACY_MISSING_MESSAGE).toMatch(/^Missing required environment variables: RUNWAY_URL and RUNWAY_APP_KEY/);
  });

  it("reads a file with several servers", () => {
    const p = write(JSON.stringify({ runways: [server(), { name: "wsv", url: "https://w.example.org", token: TOKEN_B }] }));
    const c = loadRunwayConfig({ RUNWAY_CONFIG: p });
    expect(c.mode).toBe("config");
    expect(c.servers.map((s) => s.name)).toEqual(["wiggert", "wsv"]);
    expect(c.source).toBe(p);
    expect(c.warnings).toEqual([]);
  });

  it("a file that is not JSON is reported without quoting any of it (the parser's message holds a snippet, and the file holds tokens)", () => {
    const p = write(`{"runways": [{"name": "a", "token": "${TOKEN_A}" oops`);
    let message = "";
    try {
      loadRunwayConfig({ RUNWAY_CONFIG: p });
    } catch (e) {
      message = (e as Error).message;
    }
    expect(message).toMatch(/not valid JSON/);
    expect(message).not.toContain("AAAA");
    expect(message).not.toContain("rwu_");
  });

  it("a validation error names the field and the file but never a value", () => {
    const p = write(JSON.stringify({ runways: [server({ token: APP_KEY })] }));
    let message = "";
    try {
      loadRunwayConfig({ RUNWAY_CONFIG: p });
    } catch (e) {
      message = (e as Error).message;
    }
    expect(message).toContain(p);
    expect(message).not.toContain("KKKK");
  });

  it.skipIf(process.platform === "win32")("warns, but does not fail, when other users can read the file", () => {
    const loose = write(JSON.stringify({ runways: [server()] }), 0o644);
    const c = loadRunwayConfig({ RUNWAY_CONFIG: loose });
    expect(c.servers).toHaveLength(1);
    expect(c.warnings.join("\n")).toMatch(/can be read by other users/);
    expect(c.warnings.join("\n")).toMatch(/chmod 600/);
    expect(c.warnings.join("\n")).not.toContain(TOKEN_A);

    chmodSync(loose, 0o600);
    expect(loadRunwayConfig({ RUNWAY_CONFIG: loose }).warnings).toEqual([]);
  });

  it("permissionWarning looks only at group and world bits", () => {
    if (process.platform === "win32") return;
    expect(permissionWarning("/x", 0o100600)).toBeNull();
    expect(permissionWarning("/x", 0o100400)).toBeNull();
    expect(permissionWarning("/x", 0o100640)).toMatch(/mode 640/);
    expect(permissionWarning("/x", 0o100604)).toMatch(/mode 604/);
  });

  it("a file wins over RUNWAY_URL and says so", () => {
    const p = write(JSON.stringify({ runways: [server()] }));
    const c = loadRunwayConfig({ RUNWAY_CONFIG: p, RUNWAY_URL: "https://other.example.com", RUNWAY_APP_KEY: APP_KEY });
    expect(c.mode).toBe("config");
    expect(c.warnings.join("\n")).toMatch(/ignored because the config file/);
    expect(c.warnings.join("\n")).not.toContain(APP_KEY);
  });

  it("one server by environment alone: RUNWAY_URL + RUNWAY_TOKEN", () => {
    const env = { HOME: dir, USERPROFILE: dir, RUNWAY_URL: "https://runway.example.com", RUNWAY_TOKEN: TOKEN_A };
    const c = loadRunwayConfig(env);
    expect(c.mode).toBe("config");
    expect(c.servers[0]).toMatchObject({ name: "default", url: "https://runway.example.com", token: TOKEN_A });
    expect(loadRunwayConfig({ ...env, RUNWAY_NAME: "wiggert" }).servers[0]!.name).toBe("wiggert");
    expect(() => loadRunwayConfig({ ...env, RUNWAY_APP_KEY: APP_KEY })).toThrow(/Use one/);
    expect(() => loadRunwayConfig({ HOME: dir, USERPROFILE: dir, RUNWAY_TOKEN: TOKEN_A })).toThrow(/RUNWAY_URL/);
    expect(() => loadRunwayConfig({ ...env, RUNWAY_URL: "http://runway.example.com" })).toThrow(/https/);
  });
});
