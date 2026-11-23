/**
 * Errors from the Runway API, written so an agent reads them correctly.
 *
 * Two rules: a 429 says to wait (and for how long) instead of dumping a body,
 * and nothing that looks like a credential ever ends up in a message, because
 * the message is shown to the model and may be echoed into a chat or a log.
 */

/** Longest a 429 may ask us to wait before we cap what we report. */
const MAX_WAIT_SECONDS = 3600;
const MAX_BODY_CHARS = 1000;

/** The caller asked for something that cannot be routed (which server? which app?). The text is safe to show. */
export class RunwayUsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RunwayUsageError";
  }
}

export class RunwayApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    /** Seconds the server asked us to wait, for a 429. */
    readonly retryAfter?: number
  ) {
    super(message);
    this.name = "RunwayApiError";
  }
}

/** `Retry-After` as seconds: either a number or an HTTP date. */
export function parseRetryAfter(
  value: string | null | undefined,
  now = Date.now()
): number | undefined {
  if (!value) return undefined;
  const v = value.trim();
  let seconds: number;
  if (/^\d+$/.test(v)) {
    seconds = Number(v);
  } else {
    const at = Date.parse(v);
    if (Number.isNaN(at)) return undefined;
    seconds = Math.ceil((at - now) / 1000);
  }
  if (!Number.isFinite(seconds)) return undefined;
  return Math.min(Math.max(seconds, 1), MAX_WAIT_SECONDS);
}

/** Mask exactly the secrets we hold, wherever they appear. */
export function maskSecrets(text: string, secrets: readonly string[] = []): string {
  let out = text;
  for (const s of secrets) {
    if (s && s.length >= 6) out = out.split(s).join("[redacted]");
  }
  return out;
}

/** Mask the secrets we hold, and anything shaped like a Runway token. */
export function redactSecrets(text: string, secrets: readonly string[] = []): string {
  return maskSecrets(text, secrets)
    .replace(/\b(rw[ydu]_)[A-Za-z0-9_-]{6,}/g, "$1[redacted]")
    .replace(/(Bearer\s+)[A-Za-z0-9._~+/=-]{6,}/gi, "$1[redacted]");
}

export function describeApiError(
  status: number,
  body: string,
  opts: { retryAfter?: number; secrets?: readonly string[] } = {}
): string {
  if (status === 429) {
    const wait = opts.retryAfter;
    return (
      "Runway is rate limiting this key (HTTP 429). " +
      (wait
        ? `Wait ${wait} second${wait === 1 ? "" : "s"} before the next request`
        : "Wait a minute before the next request") +
      " and do not retry in a loop."
    );
  }
  const text = redactSecrets(body, opts.secrets).slice(0, MAX_BODY_CHARS);
  return `Runway API error ${status}: ${text}`;
}

/** Turn a failed fetch Response into the error to throw. Reads the body. */
export async function apiErrorFromResponse(
  res: Response,
  secrets: readonly string[] = []
): Promise<RunwayApiError> {
  const retryAfter =
    res.status === 429 ? parseRetryAfter(res.headers.get("retry-after")) : undefined;
  const body = res.status === 429 ? "" : await res.text().catch(() => "");
  return new RunwayApiError(
    describeApiError(res.status, body, { retryAfter, secrets }),
    res.status,
    retryAfter
  );
}
