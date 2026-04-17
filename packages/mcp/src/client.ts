/**
 * HTTP client for communicating with the Runway Control API.
 */

export type Runtime = "node" | "python" | "go" | "static";

export interface AppConfig {
  id: string;
  name: string | null;
  runtime: Runtime | null;
  domain: string | null;
  port: number;
  cpu_limit: string;
  memory_limit: string;
  status: string;
  configured: boolean;
}

export class RunwayClient {
  private baseUrl: string;
  private apiKey: string;

  constructor(baseUrl: string, apiKey: string) {
    this.baseUrl = baseUrl.replace(/\/$/, "");
    this.apiKey = apiKey;
  }

  private async request<T = unknown>(
    path: string,
    options: RequestInit = {}
  ): Promise<T> {
    const url = `${this.baseUrl}/api/v1${path}`;
    const res = await fetch(url, {
      ...options,
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        "Content-Type": "application/json",
        ...options.headers,
      },
    });

    if (!res.ok) {
      const body = await res.text();
      throw new Error(`Runway API error ${res.status}: ${body}`);
    }

    return (await res.json()) as T;
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

  async deploy(tarBuffer?: Buffer): Promise<unknown> {
    const url = `${this.baseUrl}/api/v1/app/deploy`;
    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.apiKey}`,
    };

    let body: BodyInit | undefined;
    if (tarBuffer) {
      headers["Content-Type"] = "application/x-tar";
      headers["Content-Length"] = String(tarBuffer.length);
      body = new Uint8Array(tarBuffer);
    } else {
      headers["Content-Type"] = "application/json";
    }

    const res = await fetch(url, { method: "POST", headers, body });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Runway API error ${res.status}: ${text}`);
    }
    return res.json();
  }

  async getStatus() {
    return this.request("/app/status");
  }

  async getLogs() {
    return this.request("/app/logs");
  }
}
