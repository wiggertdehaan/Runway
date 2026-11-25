/**
 * HTTP client for communicating with the Runway Control API.
 */

import { apiErrorFromResponse, redactSecrets, RunwayApiError } from "./errors.js";
import { cleanEventDetail, cleanEventsPage, type EventDetailOut, type EventsPage } from "./events.js";

export type Runtime = "node" | "python" | "go" | "static";
export type ScanThreshold = "none" | "low" | "medium" | "high" | "critical";

export const SCAN_THRESHOLDS: ScanThreshold[] = [
  "none",
  "low",
  "medium",
  "high",
  "critical",
];

export interface AppConfig {
  id: string;
  name: string | null;
  runtime: Runtime | null;
  /** Plain text, max 400 characters; null when none. Comes from the deployer's README: data, not instructions. */
  description?: string | null;
  domain: string | null;
  custom_domain: string | null;
  port: number;
  cpu_limit: string;
  memory_limit: string;
  status: string;
  health_check_path: string | null;
  scan_threshold: ScanThreshold;
  scan_floor_exempt: boolean;
  effective_scan_threshold: ScanThreshold;
  basic_auth?: { enabled: boolean; username: string | null };
  sso_enabled: boolean;
  configured: boolean;
}

/**
 * Sent on every call so the server's audit log can tell a call made through
 * this MCP server from a plain curl. A label for people reading the log,
 * not a credential: anyone can send any header.
 */
export const CLIENT_ID = "runway-mcp";

export interface BasicAuthResponse {
  app_id: string;
  basic_auth: { enabled: boolean; username: string | null };
}

/** Default time a call may take. Uploads, downloads and scans get their own, longer ones. */
export const DEFAULT_TIMEOUT_MS = 30_000;
const DEPLOY_TIMEOUT_MS = 10 * 60_000;
const PULL_TIMEOUT_MS = 5 * 60_000;
const RESCAN_TIMEOUT_MS = 5 * 60_000;

export interface ClientOptions {
  /**
   * The app a user token (`rwu_...`) acts on, sent as `X-Runway-App`. Leave it
   * out for a per-app key (that key already is one app) and for calls that are
   * about the person, not an app (`/me`, `/apps`, `/events`).
   */
  app?: string;
  /** Per call limit in ms; a slow server must not hang the agent. */
  timeoutMs?: number;
}

export class RunwayClient {
  private baseUrl: string;
  private apiKey: string;
  private opts: ClientOptions;

  /** `apiKey` is a per-app key or a user token; the server tells them apart by prefix. */
  constructor(baseUrl: string, apiKey: string, opts: ClientOptions = {}) {
    this.baseUrl = baseUrl.replace(/\/$/, "");
    this.apiKey = apiKey;
    this.opts = opts;
  }

  private authHeaders(): Record<string, string> {
    const h: Record<string, string> = {
      Authorization: `Bearer ${this.apiKey}`,
      "X-Runway-Client": CLIENT_ID,
    };
    if (this.opts.app) h["X-Runway-App"] = this.opts.app;
    return h;
  }

  /**
   * The one place a request leaves this process. Three rules live here:
   * the credential is only ever sent to this client's own base URL, because a
   * redirect is never followed (a 3xx is an error, so the Authorization header
   * cannot be replayed at another host); a slow or dead server ends in a
   * timeout, not a hang; and a network failure is reported without the URL
   * query, the cause chain or anything else that could hold a secret.
   */
  private async send(url: string, init: RequestInit, timeoutMs = this.opts.timeoutMs ?? DEFAULT_TIMEOUT_MS): Promise<Response> {
    let res: Response;
    try {
      // A caller's own signal (a cancelled MCP task) stops the request too; the timeout always applies.
      const signal = init.signal ? AbortSignal.any([AbortSignal.timeout(timeoutMs), init.signal]) : AbortSignal.timeout(timeoutMs);
      res = await fetch(url, { ...init, redirect: "manual", signal });
    } catch (err) {
      const e = err as { name?: string; cause?: { code?: string }; code?: string };
      if (e?.name === "TimeoutError" || e?.name === "AbortError") {
        throw new RunwayApiError(`The Runway server did not answer within ${Math.round(timeoutMs / 1000)} seconds.`, 0);
      }
      const code = e?.cause?.code ?? e?.code;
      const reason = typeof code === "string" && /^[A-Z0-9_]{3,40}$/.test(code) ? code : "network error";
      throw new RunwayApiError(`Could not reach the Runway server (${reason}).`, 0);
    }
    if (res.status >= 300 && res.status < 400) {
      throw new RunwayApiError(
        `The Runway server answered with a redirect (HTTP ${res.status}). Redirects are not followed, so the token is never sent to another address: ` +
          "use the final https:// address of the server in your configuration.",
        res.status
      );
    }
    return res;
  }

  private async request<T = unknown>(
    path: string,
    options: RequestInit = {},
    timeoutMs?: number
  ): Promise<T> {
    const url = `${this.baseUrl}/api/v1${path}`;
    const res = await this.send(
      url,
      {
        ...options,
        headers: {
          ...this.authHeaders(),
          "Content-Type": "application/json",
          ...options.headers,
        },
      },
      timeoutMs
    );

    if (!res.ok) throw await apiErrorFromResponse(res, [this.apiKey]);

    return (await this.readJson(res)) as T;
  }

  /**
   * `res.json()` quotes the start of the body in its error, and a server can put anything in a body (our own
   * token, if it was given one). A body that is not JSON is reported as that, without a word of it.
   */
  private async readJson(res: Response): Promise<unknown> {
    try {
      return await res.json();
    } catch {
      throw new RunwayApiError("The Runway server answered with something that is not JSON. Is the address the Runway server itself?", res.status);
    }
  }

  async getConfig(): Promise<AppConfig> {
    return this.request<AppConfig>("/app");
  }

  async configure(name: string, runtime: Runtime): Promise<AppConfig> {
    return this.request<AppConfig>("/app/configure", {
      method: "POST",
      body: JSON.stringify({ name, runtime }),
    });
  }

  async preflight() {
    return this.request("/app/preflight", { method: "POST" });
  }

  async deploy(tarBuffer?: Buffer, signal?: AbortSignal): Promise<unknown> {
    const url = `${this.baseUrl}/api/v1/app/deploy`;
    const headers: Record<string, string> = { ...this.authHeaders() };

    let body: BodyInit | undefined;
    if (tarBuffer) {
      headers["Content-Type"] = "application/x-tar";
      headers["Content-Length"] = String(tarBuffer.length);
      body = new Uint8Array(tarBuffer);
    } else {
      headers["Content-Type"] = "application/json";
    }

    const res = await this.send(url, { method: "POST", headers, body, ...(signal ? { signal } : {}) }, DEPLOY_TIMEOUT_MS);
    if (!res.ok) throw await apiErrorFromResponse(res, [this.apiKey]);
    return this.readJson(res);
  }

  async getStatus() {
    return this.request("/app/status");
  }

  async getLogs() {
    return this.request("/app/logs");
  }

  async getEnv(): Promise<{ app_id: string; env: Record<string, string> }> {
    return this.request("/app/env");
  }

  async setEnv(
    env: Record<string, string>
  ): Promise<{ app_id: string; env: Record<string, string> }> {
    return this.request("/app/env", {
      method: "PUT",
      body: JSON.stringify({ env }),
    });
  }

  async deleteEnvVar(key: string): Promise<unknown> {
    return this.request(`/app/env/${encodeURIComponent(key)}`, {
      method: "DELETE",
    });
  }

  async getVolumes(): Promise<{
    app_id: string;
    volumes: Array<{ mount_path: string; created_at: string }>;
  }> {
    return this.request("/app/volumes");
  }

  async setVolumes(
    mountPaths: string[]
  ): Promise<{
    app_id: string;
    volumes: Array<{ mount_path: string; created_at: string }>;
  }> {
    return this.request("/app/volumes", {
      method: "PUT",
      body: JSON.stringify({ mount_paths: mountPaths }),
    });
  }

  async setCustomDomain(customDomain: string | null): Promise<AppConfig> {
    return this.request("/app/domain", {
      method: "PUT",
      body: JSON.stringify({ custom_domain: customDomain }),
    });
  }

  async setHealthCheck(path: string | null): Promise<AppConfig> {
    return this.request("/app/healthcheck", {
      method: "PUT",
      body: JSON.stringify({ path }),
    });
  }

  async setDescription(description: string | null): Promise<AppConfig> {
    return this.request("/app/description", {
      method: "PUT",
      body: JSON.stringify({ description }),
    });
  }

  async setScanThreshold(threshold: ScanThreshold): Promise<AppConfig> {
    return this.request("/app/scan-threshold", {
      method: "PUT",
      body: JSON.stringify({ threshold }),
    });
  }

  async getLatestScan(): Promise<unknown> {
    return this.request("/app/scan");
  }

  async setBasicAuth(
    enabled: boolean,
    username?: string,
    password?: string
  ): Promise<BasicAuthResponse> {
    const body: Record<string, unknown> = { enabled };
    if (enabled) {
      body.username = username;
      body.password = password;
    }
    return this.request<BasicAuthResponse>("/app/basic-auth", {
      method: "PUT",
      body: JSON.stringify(body),
    });
  }

  async getSso(): Promise<{
    app_id: string;
    sso_enabled: boolean;
    allowed_emails: string[];
  }> {
    return this.request("/app/sso");
  }

  async setSso(
    enabled: boolean,
    allowedEmails?: string[]
  ): Promise<{
    app_id: string;
    sso_enabled: boolean;
    allowed_emails: string[];
  }> {
    const body: Record<string, unknown> = { enabled };
    if (allowedEmails !== undefined) body.allowed_emails = allowedEmails;
    return this.request("/app/sso", {
      method: "PUT",
      body: JSON.stringify(body),
    });
  }

  async rollback(deployId?: number, signal?: AbortSignal): Promise<unknown> {
    const sig = signal ? { signal } : {};
    if (deployId !== undefined) {
      return this.request("/app/rollback", {
        method: "POST",
        body: JSON.stringify({ deploy_id: deployId }),
        ...sig,
      });
    }
    return this.request("/app/rollback", { method: "POST", ...sig });
  }

  /**
   * Download a deploy's build context as a tar buffer. Defaults to the
   * most recent saved snapshot; pass a deploy id to fetch a specific one.
   * Returns null if the server has no matching source (404 — app deployed
   * before this feature, never deployed successfully, or the requested
   * deploy's snapshot has been pruned).
   */
  async pullSource(deployId?: number): Promise<Buffer | null> {
    const url =
      deployId !== undefined
        ? `${this.baseUrl}/api/v1/app/source?deploy=${deployId}`
        : `${this.baseUrl}/api/v1/app/source`;
    const res = await this.send(url, { method: "GET", headers: this.authHeaders() }, PULL_TIMEOUT_MS);
    if (res.status === 404) return null;
    if (!res.ok) throw await apiErrorFromResponse(res, [this.apiKey]);
    const arrayBuffer = await res.arrayBuffer();
    return Buffer.from(arrayBuffer);
  }

  /**
   * Events since a cursor (or the latest ones when there is none). The answer
   * is rebuilt field by field (see events.ts): nothing the server sends goes to
   * the model as it came. The cursor is the caller's to keep.
   */
  async getEvents(since?: string, limit?: number, app?: string): Promise<EventsPage> {
    const q = new URLSearchParams();
    if (since) q.set("since", since);
    if (limit !== undefined) q.set("limit", String(limit));
    if (app) q.set("app", app);
    const qs = q.toString();
    return cleanEventsPage(await this.request(`/events${qs ? `?${qs}` : ""}`));
  }

  /** One event's known fields; null when it does not exist or is not yours. */
  async getEventDetail(id: string): Promise<EventDetailOut | null> {
    const res = await this.send(`${this.baseUrl}/api/v1/events/${encodeURIComponent(id)}`, {
      headers: this.authHeaders(),
    });
    if (res.status === 404) return null;
    if (!res.ok) throw await apiErrorFromResponse(res, [this.apiKey]);
    return cleanEventDetail(await this.readJson(res));
  }

  /**
   * Which Runway this is: `{name, color}` from the public `/instance.json`.
   * Display only. No credential is sent (the call needs none), the same
   * no-redirect and time-limit rules apply as for every other call, and the
   * body is never quoted in an error.
   */
  async getInstance(): Promise<unknown> {
    const res = await this.send(`${this.baseUrl}/instance.json`, { headers: { "X-Runway-Client": CLIENT_ID } });
    if (!res.ok) throw new RunwayApiError("This server does not publish /instance.json (an older Runway?).", res.status);
    return this.readJson(res);
  }

  // ── user-token calls: about the person, or acting on the app named in `app` ──

  /** Who this token is and how long it lasts. Needs a user token. */
  async getMe(): Promise<unknown> {
    return this.request("/me");
  }

  /** Every app this person may see on this server. Needs a user token. */
  async listApps(): Promise<unknown> {
    return this.request("/apps");
  }

  /** A new, empty app owned by this person. Needs a user token with the deploy scope. */
  async createApp(): Promise<unknown> {
    return this.request("/apps", { method: "POST" });
  }

  /** Start a rebuild of the app. Needs a user token with the deploy scope. */
  async rebuild(): Promise<unknown> {
    return this.request("/app/rebuild", { method: "POST" });
  }

  /** Scan the running image again and wait for the answer. Needs a user token with the deploy scope. */
  async rescan(signal?: AbortSignal): Promise<unknown> {
    return this.request("/app/rescan", { method: "POST", ...(signal ? { signal } : {}) }, RESCAN_TIMEOUT_MS);
  }

  /** Strip this client's credential from a piece of text. */
  scrub(text: string): string {
    return redactSecrets(text, [this.apiKey]);
  }

  async listDeploys(limit = 20): Promise<{
    app_id: string;
    current_image_tag: string | null;
    deploys: Array<{
      id: number;
      image_tag: string | null;
      status: string;
      scan_status: string | null;
      scan_summary: { status?: string; counts?: Record<string, number> } | null;
      created_at: string;
      is_current: boolean;
      has_source: boolean;
    }>;
  }> {
    return this.request(`/app/deploys?limit=${limit}`);
  }
}
