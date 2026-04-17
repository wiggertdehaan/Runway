import type { Context, Next } from "hono";

/**
 * Set baseline security response headers on every HTML/JSON response.
 * These aren't magic — they nudge modern browsers into stricter behavior
 * and keep Chrome from flagging forms with password fields as "not secure"
 * on HTTPS pages that lack HSTS.
 */
export async function securityHeaders(c: Context, next: Next) {
  await next();

  // HSTS — tell browsers (and Chrome's HTTPS-first heuristics) that
  // this host is HTTPS-only. 1 year; do not set `preload` or
  // `includeSubDomains` without explicit user consent because apps
  // deployed under the same base domain may still be bootstrapping.
  c.header("Strict-Transport-Security", "max-age=31536000");

  // Block MIME sniffing so an HTML-looking response served with a
  // different content-type cannot be reinterpreted.
  c.header("X-Content-Type-Options", "nosniff");

  // Reduce referrer leakage to third parties (e.g. the htmx CDN).
  c.header("Referrer-Policy", "strict-origin-when-cross-origin");

  // Do not render the dashboard inside a frame of another origin.
  c.header("X-Frame-Options", "DENY");

  // CSP: allow self-hosted resources and the htmx CDN. Inline styles
  // are needed for the server-rendered HTML. Inline scripts are used
  // for copy/reveal buttons — unsafe-inline is acceptable here because
  // we control all rendered content and escape user input.
  c.header(
    "Content-Security-Policy",
    [
      "default-src 'self'",
      "script-src 'self' 'unsafe-inline' https://unpkg.com",
      "style-src 'self' 'unsafe-inline'",
      "img-src 'self' data:",
      "connect-src 'self'",
      "frame-ancestors 'none'",
    ].join("; ")
  );
}
