/**
 * docker-compose.yml must hand control every setting an operator is told they
 * can change. Two of them (the app-network emergency brake and the audit
 * retention) were once documented but never passed on, so setting them in
 * .env did nothing. This test reads the compose file and the source and fails
 * when a setting is read but neither passed nor deliberately left internal.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import yaml from "js-yaml";
import { describe, expect, it } from "vitest";

const here = dirname(fileURLToPath(import.meta.url));
const compose = yaml.load(readFileSync(join(here, "../../../docker-compose.yml"), "utf8")) as {
  services: { control: { environment: string[] } };
};
const entries = compose.services.control.environment;
const passed = new Map<string, string>(
  entries.map((e) => {
    const i = e.indexOf("=");
    return [e.slice(0, i), e.slice(i + 1)] as [string, string];
  })
);

/** Read by the code but fixed by the image or a volume layout; not for operators. */
const INTERNAL = new Set([
  "TRIVY_BIN",
  "TRIVY_CACHE_DIR",
  "SOURCES_DIR",
  "UPLOAD_DIR",
  "KEV_CACHE_PATH",
  "GATEWAY_CONTAINER",
]);

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) sourceFiles(p, out);
    else if (p.endsWith(".ts") && !p.endsWith(".test.ts")) out.push(p);
  }
  return out;
}

function envNamesRead(): Set<string> {
  const names = new Set<string>();
  for (const file of sourceFiles(here)) {
    const text = readFileSync(file, "utf8");
    for (const m of text.matchAll(/(?:process\.env|\benv)\.([A-Z][A-Z0-9_]{3,})/g)) names.add(m[1]!);
    for (const m of text.matchAll(/process\.env\["([A-Z][A-Z0-9_]+)"\]/g)) names.add(m[1]!);
    for (const m of text.matchAll(/\benvInt\("([A-Z][A-Z0-9_]+)"/g)) names.add(m[1]!);
  }
  return names;
}

describe("docker-compose.yml control environment", () => {
  it("passes every setting the code reads, unless it is deliberately internal", () => {
    const missing = [...envNamesRead()].filter((n) => !passed.has(n) && !INTERNAL.has(n)).sort();
    expect(missing).toEqual([]);
  });

  it("passes the three that used to be missing", () => {
    for (const name of ["RUNWAY_APP_NETWORK_MODE", "AUDIT_API_RETENTION_DAYS", "AUDIT_API_MAX_ROWS"]) {
      expect(passed.get(name), name).toBe("${" + name + ":-}");
    }
  });

  it("passes optional settings through with an EMPTY default, so the code defaults stay in charge", () => {
    const fixed = new Set([
      "DB_PATH",
      "PORT",
      "GATEWAY_CONFIG_DIR",
      "GATEWAY_LOG_PATH",
      "RUNWAY_NETWORK",
      "BUILDKIT_CONTAINER",
      "DASHBOARD_DOMAIN",
    ]);
    for (const [name, value] of passed) {
      if (fixed.has(name)) continue;
      expect(value, name).toBe("${" + name + ":-}");
    }
  });

  it("lists no variable twice", () => {
    expect(entries.length).toBe(passed.size);
  });

  it("the code treats an empty value as 'use the default' for each new pass-through", async () => {
    // compose turns an unset VAR into "" inside the container.
    const { networkMode } = await import("./deploy/networks.js");
    expect(networkMode({ RUNWAY_APP_NETWORK_MODE: "" })).toBe("per-app");
    expect(networkMode({ RUNWAY_APP_NETWORK_MODE: "shared" })).toBe("shared");
    const { apiAuditRetentionDays, apiAuditMaxRows } = await import("./db/audit.js");
    const saved = { d: process.env.AUDIT_API_RETENTION_DAYS, r: process.env.AUDIT_API_MAX_ROWS };
    process.env.AUDIT_API_RETENTION_DAYS = "";
    process.env.AUDIT_API_MAX_ROWS = "";
    try {
      expect(apiAuditRetentionDays()).toBe(90);
      expect(apiAuditMaxRows()).toBe(100_000);
    } finally {
      if (saved.d === undefined) delete process.env.AUDIT_API_RETENTION_DAYS;
      else process.env.AUDIT_API_RETENTION_DAYS = saved.d;
      if (saved.r === undefined) delete process.env.AUDIT_API_MAX_ROWS;
      else process.env.AUDIT_API_MAX_ROWS = saved.r;
    }
  });
});
