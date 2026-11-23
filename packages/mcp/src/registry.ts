/**
 * The set of Runway servers this process knows, and the rule for picking the
 * server, the app and the credential of one call.
 *
 * No federation: a server knows nothing of the others. The only thing that
 * ties them together is this object, in the local process, and it never mixes
 * credentials: a client made here carries one base URL and the one credential
 * that belongs to that URL.
 */

import { RunwayClient } from "./client.js";
import { RunwayUsageError } from "./errors.js";
import type { LoadedConfig, ServerConfig } from "./config.js";

const APP_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

export interface ClientFor {
  client: RunwayClient;
  server: ServerConfig;
}

export interface ClientForOptions {
  /**
   * The call is about the person (events, the app list), not about one app: a
   * user token needs no app then, and an app named anyway only narrows the
   * answer. A server that has app keys only still needs to know which key.
   */
  account?: boolean;
  /** A shorter limit for calls that only look (list, probe, events). */
  timeoutMs?: number;
}

export class RunwayRegistry {
  readonly mode: LoadedConfig["mode"];
  readonly servers: readonly ServerConfig[];
  readonly warnings: readonly string[];

  constructor(config: LoadedConfig) {
    this.mode = config.mode;
    this.servers = config.servers;
    this.warnings = config.warnings;
  }

  /** True when the agent has to say which server it means. */
  get multiple(): boolean {
    return this.servers.length > 1;
  }

  /** Every credential held, for masking in anything that is shown. */
  secrets(): string[] {
    const out: string[] = [];
    for (const s of this.servers) {
      if (s.token) out.push(s.token);
      if (s.legacyKey) out.push(s.legacyKey);
      out.push(...Object.values(s.appKeys));
    }
    return out;
  }

  names(): string[] {
    return this.servers.map((s) => s.name);
  }

  /** Pick a server. With one configured the name is optional; with several it never is guessed. */
  resolve(runway?: string): ServerConfig {
    const wanted = runway?.trim().toLowerCase();
    if (wanted) {
      const hit = this.servers.find((s) => s.name === wanted);
      if (hit) return hit;
      throw new RunwayUsageError(`No Runway called '${runway!.slice(0, 40)}'. Configured: ${this.names().join(", ")}. See runway_list_runways.`);
    }
    if (this.servers.length === 1) return this.servers[0]!;
    throw new RunwayUsageError(`Several Runways are configured (${this.names().join(", ")}): say which one with \`runway\`. See runway_list_runways.`);
  }

  /** The servers a call is about: the named one, or all of them. */
  select(runway?: string): ServerConfig[] {
    return runway?.trim() ? [this.resolve(runway)] : [...this.servers];
  }

  /**
   * The client for one call: base URL and credential of the server, plus the
   * app where the credential needs one. An app key wins for its own app and is
   * sent without an app header (the key is the app); a user token acts on the
   * app named in `X-Runway-App`.
   */
  clientFor(runway: string | undefined, app: string | undefined, opts: ClientForOptions = {}): ClientFor {
    const server = this.resolve(runway);
    const appId = app?.trim() || undefined;
    const base = opts.timeoutMs ? { timeoutMs: opts.timeoutMs } : {};
    if (appId && !APP_ID_RE.test(appId)) {
      throw new RunwayUsageError("`app` must be an app id (letters, digits, '-' or '_'). See runway_list_apps.");
    }

    // Legacy: one app key from the environment. It is the app, so `app` is not needed (and not used).
    if (server.legacyKey) {
      return { client: new RunwayClient(server.url, server.legacyKey, base), server };
    }

    if (appId && server.appKeys[appId]) {
      return { client: new RunwayClient(server.url, server.appKeys[appId]!, base), server };
    }

    if (server.token) {
      if (!appId && !opts.account) {
        throw new RunwayUsageError(
          `Runway '${server.name}' is used with a user token, which reaches all your apps there: say which one with \`app\`. See runway_list_apps.`
        );
      }
      // An account call (events, the list) is about the person: the app, if given, only narrows the answer (`?app=`)
      // and is not sent as the app the request acts on.
      return { client: new RunwayClient(server.url, server.token, { ...base, ...(appId && !opts.account ? { app: appId } : {}) }), server };
    }

    // Only per-app keys here.
    const ids = Object.keys(server.appKeys);
    if (!appId && ids.length === 1) {
      return { client: new RunwayClient(server.url, server.appKeys[ids[0]!]!, base), server };
    }
    if (appId) {
      throw new RunwayUsageError(`Runway '${server.name}' has no key for app '${appId}'. Apps with a key: ${ids.join(", ")}.`);
    }
    throw new RunwayUsageError(`Runway '${server.name}' has keys for several apps (${ids.join(", ")}): say which one with \`app\`.`);
  }
}
