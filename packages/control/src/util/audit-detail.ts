/**
 * Pure helpers for the audit lines the API writes (S12).
 *
 * One rule runs through all of them: the audit log says WHAT was changed and
 * by WHOM, never the values. An env var's name goes in, its value never does;
 * a password field's presence goes in, the password never does. The log is
 * readable by every administrator and ends up in backups and screenshots, so
 * a secret that lands in it is a secret that is hard to take back.
 */

/** Longest detail string that is stored. */
export const MAX_DETAIL = 300;

const MAX_NAME = 48;
const MAX_KEYS = 20;
const MAX_SUBKEYS = 20;

/**
 * Scalar fields whose VALUE is safe and useful in the log (a hostname, a
 * runtime, a threshold). Everything else is recorded by name only. Adding a
 * field here is a deliberate decision: it must never hold a credential.
 */
export const SAFE_SCALAR_FIELDS: ReadonlySet<string> = new Set([
  "name",
  "runtime",
  "scan_threshold",
  "custom_domain",
  "health_check_path",
  "path",
  "domain",
]);

/** Keep a client-supplied name to a short, inert string. */
export function safeName(value: unknown, max = MAX_NAME): string {
  const s = typeof value === "string" ? value : String(value ?? "");
  return s.replace(/[^A-Za-z0-9_.:/-]/g, "").slice(0, max);
}

/**
 * Last line of defence: if a token-shaped string slipped into a detail
 * (a client that used a secret as a field name, say), it is masked. Runway's
 * own formats are covered: app keys (rwy_), developer tokens (rwd_), user
 * tokens (rwu_), and a Bearer header value.
 */
export function scrubSecrets(text: string): string {
  return text
    .replace(/\brw[ydu]_[A-Za-z0-9_-]{6,}/g, "[redacted]")
    .replace(/\bBearer\s+\S+/gi, "Bearer [redacted]");
}

/** Make a detail string safe to store: no control characters, scrubbed, capped. */
export function finalizeDetail(text: string): string {
  // eslint-disable-next-line no-control-regex
  const clean = text.replace(/[\u0000-\u001f\u007f]+/g, " ").trim();
  const scrubbed = scrubSecrets(clean);
  return scrubbed.length > MAX_DETAIL
    ? `${scrubbed.slice(0, MAX_DETAIL - 1)}…`
    : scrubbed;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * Describe a JSON request body by its SHAPE: field names, nested key names,
 * booleans and a short list of safe scalars. Never a value of any other field.
 *
 *   { env: { DB_URL: "postgres://…", TOKEN: "x" }, sso_enabled: true }
 *   → "env{DB_URL,TOKEN} sso_enabled=true"
 */
export function describeBody(body: unknown): string {
  if (!isPlainObject(body)) return "";
  const parts: string[] = [];
  const keys = Object.keys(body);
  for (const key of keys.slice(0, MAX_KEYS)) {
    const k = safeName(key);
    if (!k) continue;
    const v = body[key];
    if (typeof v === "boolean") {
      parts.push(`${k}=${v}`);
    } else if (typeof v === "string" && SAFE_SCALAR_FIELDS.has(key)) {
      parts.push(`${k}=${safeName(v, 60)}`);
    } else if (isPlainObject(v)) {
      const subs = Object.keys(v);
      const shown = subs
        .slice(0, MAX_SUBKEYS)
        .map((s) => safeName(s))
        .filter(Boolean);
      const more = subs.length > MAX_SUBKEYS ? `,+${subs.length - MAX_SUBKEYS}` : "";
      parts.push(`${k}{${shown.join(",")}${more}}`);
    } else if (Array.isArray(v)) {
      parts.push(`${k}[${v.length}]`);
    } else {
      parts.push(k);
    }
  }
  if (keys.length > MAX_KEYS) parts.push(`+${keys.length - MAX_KEYS} more`);
  return parts.join(" ");
}

/**
 * "PUT /api/v1/app/env/:key" → "api_put_env". The path parameters are left
 * out, so the name is the same for every call to the same endpoint.
 */
export function actionFor(method: string, routePath: string): string {
  const segments = routePath
    .replace(/^\/api\/v1\/?/, "")
    .split("/")
    .filter((seg) => seg && !seg.startsWith(":"));
  // Routes about one app live under /app/…; the word "app" itself adds nothing.
  if (segments[0] === "app") segments.shift();
  const sub = segments
    .join("_")
    .replace(/[^A-Za-z0-9_]/g, "")
    .toLowerCase();
  return `api_${method.toLowerCase()}_${sub || "app"}`;
}

export type AuditResult = "ok" | "denied" | "rejected" | "error";

/** 2xx/3xx = ok, 401/403 = denied, other 4xx = rejected, 5xx = error. */
export function resultForStatus(status: number): AuditResult {
  if (status >= 500) return "error";
  if (status === 401 || status === 403) return "denied";
  if (status >= 400) return "rejected";
  return "ok";
}

/**
 * The calling client, as the MCP client announces itself ("runway-mcp/0.26.0").
 * It is a hint, not proof: anyone can send any header, so it is only shown,
 * never used to decide anything.
 */
export function clientHint(header: string | undefined | null): string | null {
  if (!header) return null;
  const clean = header.replace(/[^A-Za-z0-9._/-]/g, "").slice(0, 40);
  return clean || null;
}

/** Path parameters (env var name, volume path, deploy id) as a short string. */
export function describeParams(params: Record<string, string>): string {
  const parts: string[] = [];
  for (const [k, v] of Object.entries(params).slice(0, 4)) {
    const name = safeName(k, 20);
    const value = safeName(v, 60);
    if (name && value) parts.push(`${name}=${value}`);
  }
  return parts.join(" ");
}
