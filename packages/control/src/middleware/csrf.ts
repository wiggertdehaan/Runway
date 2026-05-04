import { randomBytes, timingSafeEqual } from "node:crypto";
import type { Context, Next } from "hono";
import { getCookie, setCookie } from "hono/cookie";

const CSRF_COOKIE = "runway_csrf";
const CSRF_FIELD = "_csrf";
const TOKEN_BYTES = 32;

function generateToken(): string {
  return randomBytes(TOKEN_BYTES).toString("base64url");
}

function isSecureRequest(c: Context): boolean {
  const forwarded = c.req.header("x-forwarded-proto");
  if (forwarded) return forwarded.split(",")[0]?.trim() === "https";
  return new URL(c.req.url).protocol === "https:";
}

export function getCsrfToken(c: Context): string {
  let token = getCookie(c, CSRF_COOKIE);
  if (!token) {
    token = generateToken();
    setCookie(c, CSRF_COOKIE, token, {
      httpOnly: true,
      sameSite: "Lax",
      path: "/",
      maxAge: 60 * 60 * 24,
      secure: isSecureRequest(c),
    });
  }
  return token;
}

export function csrfField(c: Context): string {
  const token = getCsrfToken(c);
  return `<input type="hidden" name="${CSRF_FIELD}" value="${token}" />`;
}

/**
 * Inject a hidden CSRF input right after every <form ... method="POST" ...>
 * tag in the given HTML. Used by both layout() and partial responses
 * (e.g. /partials/apps) so htmx-swapped fragments keep working without
 * requiring every form template to remember to render csrfField()
 * itself.
 */
export function injectCsrfFields(html: string, c: Context): string {
  const field = csrfField(c);
  return html.replace(/(<form\s[^>]*method="POST"[^>]*>)/gi, `$1${field}`);
}

export async function verifyCsrf(c: Context, next: Next) {
  if (c.req.method !== "POST") {
    return next();
  }

  // Skip CSRF for API routes (they use Bearer tokens)
  if (c.req.path.startsWith("/api/")) {
    return next();
  }

  const cookieToken = getCookie(c, CSRF_COOKIE);
  if (!cookieToken) {
    return c.text("CSRF validation failed", 403);
  }

  const contentType = c.req.header("content-type") || "";
  let formToken: string | undefined;

  if (contentType.includes("application/x-www-form-urlencoded") || contentType.includes("multipart/form-data")) {
    const body = await c.req.parseBody();
    formToken = body[CSRF_FIELD] as string | undefined;
  }

  if (!formToken) {
    return c.text("CSRF validation failed", 403);
  }

  const a = Buffer.from(cookieToken);
  const b = Buffer.from(formToken);
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    return c.text("CSRF validation failed", 403);
  }

  await next();
}
