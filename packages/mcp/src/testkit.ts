/**
 * Shared by the step 14 tests: a few Runway servers that exist only as a
 * function. Not part of the product (nothing imports it outside tests).
 */
import { vi } from "vitest";
import { RunwayRegistry } from "./registry.js";
import type { LoadedConfig, ServerConfig } from "./config.js";

export const TOKEN_A = "rwu_AAAAAAAAAAAAAAAAAAAAAAAAAAAA1";
export const TOKEN_B = "rwu_BBBBBBBBBBBBBBBBBBBBBBBBBBBB2";
export const TOKEN_C = "rwu_CCCCCCCCCCCCCCCCCCCCCCCCCCCC3";
export const APP_KEY_X = "rwy_XXXXXXXXXXXXXXXXXXXXXXXXXXXX4";
export const APP_KEY_Y = "rwy_YYYYYYYYYYYYYYYYYYYYYYYYYYYY5";

export const SERVER_A: ServerConfig = { name: "alpha", url: "https://alpha.example.com", token: TOKEN_A, appKeys: {} };
export const SERVER_B: ServerConfig = { name: "beta", url: "https://beta.example.org", token: TOKEN_B, appKeys: {} };
export const SERVER_C: ServerConfig = { name: "gamma", url: "https://gamma.example.net", appKeys: { appxone: APP_KEY_X, appytwo: APP_KEY_Y } };

export function registryOf(...servers: ServerConfig[]): RunwayRegistry {
  const config: LoadedConfig = { mode: "config", servers, warnings: [], source: "test" };
  return new RunwayRegistry(config);
}

export function legacyRegistry(url = "https://legacy.example.com", key = APP_KEY_X): RunwayRegistry {
  return new RunwayRegistry({
    mode: "legacy",
    servers: [{ name: "default", url, appKeys: {}, legacyKey: key }],
    warnings: [],
    source: "legacy environment",
  });
}

export interface Call {
  url: string;
  host: string;
  path: string;
  method: string;
  headers: Record<string, string>;
  init: RequestInit;
}

export type Handler = (call: Call) => Response | Promise<Response> | Error;

export function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
}

/**
 * Replace global fetch with a router keyed by host. A handler may return a
 * Response, or an Error to make the request fail like a network error.
 * Returns the recorded calls.
 */
export function stubServers(handlers: Record<string, Handler>): Call[] {
  const calls: Call[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string | URL, init: RequestInit = {}) => {
      const u = new URL(String(input));
      const call: Call = {
        url: String(input),
        host: u.host,
        path: u.pathname + u.search,
        method: init.method ?? "GET",
        headers: (init.headers ?? {}) as Record<string, string>,
        init,
      };
      calls.push(call);
      const h = handlers[u.host];
      if (!h) throw new TypeError("fetch failed", { cause: { code: "ENOTFOUND" } });
      const out = await h(call);
      if (out instanceof Error) throw out;
      return out;
    })
  );
  return calls;
}

export function eventRow(cursor: string, over: Record<string, unknown> = {}) {
  return {
    id: cursor,
    cursor,
    ts: "2026-11-23T10:00:00.000Z",
    type: "deploy",
    app_id: "appxone",
    code: "deploy_failed:build",
    severity: "warning",
    summary: "A deploy failed while building.",
    ...over,
  };
}
