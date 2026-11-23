/**
 * Which Runway servers this MCP client talks to, and with what credential.
 *
 * Two ways to configure it, and the old one keeps working untouched:
 *
 *   1. No config file: RUNWAY_URL + RUNWAY_APP_KEY, one server, one app key.
 *      This is the "legacy" mode every existing install uses. Nothing in this
 *      file validates it more strictly than before.
 *   2. A config file (`~/.runway/config.json`, or the path in RUNWAY_CONFIG)
 *      with one or more servers, each with a user token (`rwu_...`) and/or a
 *      few per-app keys. A single server can also be given by env alone
 *      (RUNWAY_URL + RUNWAY_TOKEN).
 *
 * Nothing in here ever puts a credential in a message. The messages name the
 * server, the field and the environment variable, never a value, and a file
 * that is not valid JSON is reported without quoting any of it (the parser's
 * own message can contain a piece of the text, and the text holds tokens).
 */

import { existsSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

export interface ServerConfig {
  /** Short name the agent uses in the `runway` argument. */
  name: string;
  /** Base URL, no trailing slash. */
  url: string;
  /** User token (`rwu_...`): reaches every app this person may see. */
  token?: string;
  /** Per-app keys (`rwy_...`), by app id. Win over the token for that app. */
  appKeys: Record<string, string>;
  /** Legacy mode only: the one app key from RUNWAY_APP_KEY. It serves whatever app that key belongs to. */
  legacyKey?: string;
}

export interface LoadedConfig {
  /** `legacy`: one app key from env, as before. `config`: servers from a file or from RUNWAY_TOKEN. */
  mode: "legacy" | "config";
  servers: ServerConfig[];
  /** Things worth telling the person at startup. Never contain a credential. */
  warnings: string[];
  /** Where the config came from, for messages: a path, "environment" or "legacy environment". */
  source: string;
}

const NAME_RE = /^[a-z0-9][a-z0-9_-]{0,31}$/;
const APP_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const ENV_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;
const MAX_SERVERS = 20;
const MAX_APP_KEYS = 50;
const SERVER_FIELDS = new Set(["name", "url", "token", "token_env", "app_keys", "allow_insecure"]);
const TOP_FIELDS = new Set(["runways"]);

export const LEGACY_MISSING_MESSAGE =
  "Missing required environment variables: RUNWAY_URL and RUNWAY_APP_KEY " +
  "(or set RUNWAY_URL and RUNWAY_TOKEN, or write ~/.runway/config.json for several Runway servers)";

export function defaultConfigPath(env: NodeJS.ProcessEnv = process.env): string {
  return env.RUNWAY_CONFIG && env.RUNWAY_CONFIG.trim() ? env.RUNWAY_CONFIG : join(homedir(), ".runway", "config.json");
}

function isLoopbackHost(hostname: string): boolean {
  const h = hostname.toLowerCase();
  return h === "localhost" || h.endsWith(".localhost") || h === "127.0.0.1" || /^127\.\d+\.\d+\.\d+$/.test(h) || h === "[::1]" || h === "::1";
}

/** Validate one server URL and return it without a trailing slash. */
export function normalizeServerUrl(raw: string, name: string, allowInsecure: boolean): string {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new ConfigError(`Runway '${name}': "url" is not a valid URL.`);
  }
  if (u.username || u.password) {
    throw new ConfigError(`Runway '${name}': "url" must not contain a user name or password; put the credential in "token".`);
  }
  if (u.search || u.hash) {
    throw new ConfigError(`Runway '${name}': "url" must not contain a query or a fragment.`);
  }
  if (u.protocol === "https:") {
    // fine
  } else if (u.protocol === "http:") {
    if (!isLoopbackHost(u.hostname) && !allowInsecure) {
      throw new ConfigError(
        `Runway '${name}': "url" uses http, which would send the token in the clear. Use https, ` +
          `or set "allow_insecure": true if you really mean it (only for a network you control).`
      );
    }
  } else {
    throw new ConfigError(`Runway '${name}': "url" must start with https://.`);
  }
  return u.toString().replace(/\/+$/, "");
}

function describeKind(v: unknown): string {
  if (v === null) return "null";
  if (Array.isArray(v)) return "an array";
  return `a ${typeof v}`;
}

/**
 * Turn the parsed JSON of a config file into servers. `env` is only read for
 * the variables a server names in "token_env".
 */
export function parseConfig(raw: unknown, env: NodeJS.ProcessEnv = process.env): ServerConfig[] {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new ConfigError('The config must be a JSON object like {"runways": [ ... ]}.');
  }
  const top = raw as Record<string, unknown>;
  const unknownTop = Object.keys(top).filter((k) => !TOP_FIELDS.has(k));
  if (unknownTop.length > 0) {
    throw new ConfigError(`Unknown field(s) in the config: ${unknownTop.map((k) => JSON.stringify(k.slice(0, 40))).join(", ")}. Known: "runways".`);
  }
  const list = top.runways;
  if (!Array.isArray(list) || list.length === 0) {
    throw new ConfigError('The config needs a non-empty "runways" array.');
  }
  if (list.length > MAX_SERVERS) {
    throw new ConfigError(`At most ${MAX_SERVERS} Runway servers can be configured.`);
  }

  const seen = new Set<string>();
  const out: ServerConfig[] = [];
  list.forEach((entry, index) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      throw new ConfigError(`runways[${index}] must be an object, not ${describeKind(entry)}.`);
    }
    const e = entry as Record<string, unknown>;
    const nameRaw = e.name;
    const label = typeof nameRaw === "string" && NAME_RE.test(nameRaw) ? nameRaw : `#${index}`;

    const unknown = Object.keys(e).filter((k) => !SERVER_FIELDS.has(k));
    if (unknown.length > 0) {
      throw new ConfigError(
        `Runway '${label}': unknown field(s) ${unknown.map((k) => JSON.stringify(k.slice(0, 40))).join(", ")}. ` +
          `Known: ${[...SERVER_FIELDS].join(", ")}.`
      );
    }

    if (typeof nameRaw !== "string" || !NAME_RE.test(nameRaw)) {
      throw new ConfigError(
        `runways[${index}]: "name" is required: 1 to 32 lowercase letters, digits, "-" or "_", starting with a letter or digit.`
      );
    }
    if (seen.has(nameRaw)) throw new ConfigError(`Two Runways are called '${nameRaw}'. Names must be unique.`);
    seen.add(nameRaw);

    if (typeof e.url !== "string" || !e.url.trim()) {
      throw new ConfigError(`Runway '${nameRaw}': "url" is required.`);
    }
    if (e.allow_insecure !== undefined && typeof e.allow_insecure !== "boolean") {
      throw new ConfigError(`Runway '${nameRaw}': "allow_insecure" must be true or false.`);
    }
    const url = normalizeServerUrl(e.url.trim(), nameRaw, e.allow_insecure === true);

    if (e.token !== undefined && e.token_env !== undefined) {
      throw new ConfigError(`Runway '${nameRaw}': give either "token" or "token_env", not both.`);
    }

    let token: string | undefined;
    if (e.token !== undefined) {
      if (typeof e.token !== "string" || !e.token.trim()) {
        throw new ConfigError(`Runway '${nameRaw}': "token" must be a non-empty string.`);
      }
      token = e.token.trim();
    } else if (e.token_env !== undefined) {
      if (typeof e.token_env !== "string" || !ENV_NAME_RE.test(e.token_env)) {
        throw new ConfigError(`Runway '${nameRaw}': "token_env" must be the name of an environment variable.`);
      }
      const fromEnv = env[e.token_env];
      if (!fromEnv || !fromEnv.trim()) {
        throw new ConfigError(`Runway '${nameRaw}': the environment variable ${e.token_env} (its "token_env") is not set.`);
      }
      token = fromEnv.trim();
    }
    if (token !== undefined) {
      if (token.startsWith("rwy_")) {
        throw new ConfigError(
          `Runway '${nameRaw}': that looks like a per-app key (rwy_...), not a user token. ` +
            `Put per-app keys under "app_keys": {"<app id>": "rwy_..."}; "token" takes a user token (rwu_...) from Account > Access tokens.`
        );
      }
      if (!token.startsWith("rwu_")) {
        throw new ConfigError(`Runway '${nameRaw}': a user token starts with rwu_ (make one under Account > Access tokens on that server).`);
      }
    }

    const appKeys: Record<string, string> = {};
    if (e.app_keys !== undefined) {
      if (!e.app_keys || typeof e.app_keys !== "object" || Array.isArray(e.app_keys)) {
        throw new ConfigError(`Runway '${nameRaw}': "app_keys" must be an object of app id to key.`);
      }
      const entries = Object.entries(e.app_keys as Record<string, unknown>);
      if (entries.length > MAX_APP_KEYS) {
        throw new ConfigError(`Runway '${nameRaw}': at most ${MAX_APP_KEYS} app keys per server; use a user token instead.`);
      }
      for (const [appId, key] of entries) {
        if (!APP_ID_RE.test(appId)) {
          throw new ConfigError(`Runway '${nameRaw}': "${appId.slice(0, 40)}" is not a valid app id in "app_keys".`);
        }
        if (typeof key !== "string" || !key.trim()) {
          throw new ConfigError(`Runway '${nameRaw}': the key for app '${appId}' must be a non-empty string.`);
        }
        appKeys[appId] = key.trim();
      }
    }

    if (token === undefined && Object.keys(appKeys).length === 0) {
      throw new ConfigError(`Runway '${nameRaw}': needs a "token" (or "token_env"), or at least one entry in "app_keys".`);
    }
    out.push({ name: nameRaw, url, token, appKeys });
  });
  return out;
}

/** The warning for a config file other people on this machine can read. */
export function permissionWarning(path: string, mode: number): string | null {
  if (process.platform === "win32") return null;
  if ((mode & 0o077) === 0) return null;
  return (
    `The config file ${path} can be read by other users on this machine (mode ${(mode & 0o777).toString(8)}). ` +
    `It holds tokens: run  chmod 600 ${path}  or keep the tokens in environment variables with "token_env".`
  );
}

/**
 * Decide what to run with. Throws a ConfigError with a message that is safe to
 * print. A test points RUNWAY_CONFIG at a file in a temp dir.
 */
export function loadRunwayConfig(env: NodeJS.ProcessEnv = process.env): LoadedConfig {
  const warnings: string[] = [];
  const explicit = env.RUNWAY_CONFIG && env.RUNWAY_CONFIG.trim() ? env.RUNWAY_CONFIG : undefined;
  const path = defaultConfigPath(env);

  if (explicit && !existsSync(path)) {
    throw new ConfigError(`RUNWAY_CONFIG points to ${path}, but there is no such file.`);
  }

  if (existsSync(path)) {
    let text: string;
    try {
      text = readFileSync(path, "utf8");
    } catch (err) {
      const code = (err as NodeJS.ErrnoException)?.code ?? "unknown error";
      throw new ConfigError(`Cannot read the config file ${path} (${code}).`);
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      // The parser's message can quote a piece of the file, which holds tokens: say nothing of the content.
      throw new ConfigError(`The config file ${path} is not valid JSON.`);
    }
    let servers: ServerConfig[];
    try {
      servers = parseConfig(parsed, env);
    } catch (err) {
      if (err instanceof ConfigError) throw new ConfigError(`${path}: ${err.message}`);
      throw err;
    }
    try {
      const w = permissionWarning(path, statSync(path).mode);
      if (w) warnings.push(w);
    } catch {
      // cannot stat: nothing to warn about
    }
    if (env.RUNWAY_URL || env.RUNWAY_APP_KEY || env.RUNWAY_TOKEN) {
      warnings.push(`RUNWAY_URL, RUNWAY_APP_KEY and RUNWAY_TOKEN are ignored because the config file ${path} is used.`);
    }
    return { mode: "config", servers, warnings, source: path };
  }

  // No file. A user token from the environment: one server, still "config" mode (it needs an app per call).
  if (env.RUNWAY_TOKEN) {
    if (env.RUNWAY_APP_KEY) {
      throw new ConfigError("Both RUNWAY_APP_KEY and RUNWAY_TOKEN are set. Use one: an app key serves one app, a user token serves all your apps.");
    }
    if (!env.RUNWAY_URL) {
      throw new ConfigError("RUNWAY_TOKEN is set but RUNWAY_URL is not.");
    }
    const name = env.RUNWAY_NAME && env.RUNWAY_NAME.trim() ? env.RUNWAY_NAME.trim() : "default";
    const servers = parseConfig(
      { runways: [{ name, url: env.RUNWAY_URL, token_env: "RUNWAY_TOKEN" }] },
      env
    );
    return { mode: "config", servers, warnings, source: "environment" };
  }

  // The old way: one app key. Exactly as before, no new validation.
  if (!env.RUNWAY_URL || !env.RUNWAY_APP_KEY) {
    throw new ConfigError(LEGACY_MISSING_MESSAGE);
  }
  return {
    mode: "legacy",
    servers: [{ name: "default", url: env.RUNWAY_URL.replace(/\/$/, ""), appKeys: {}, legacyKey: env.RUNWAY_APP_KEY }],
    warnings,
    source: "legacy environment",
  };
}
