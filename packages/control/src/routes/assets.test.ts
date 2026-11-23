import { createHash } from "node:crypto";
import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { securityHeaders } from "../middleware/security.js";
import { HTMX_INTEGRITY, HTMX_PATH, assetRoutes } from "./assets.js";

function appWithHeaders() {
  const app = new Hono();
  app.use(securityHeaders);
  app.route("/", assetRoutes);
  return app;
}

describe("self-hosted htmx", () => {
  it("serves a versioned path from our own origin", async () => {
    expect(HTMX_PATH).toMatch(/^\/assets\/htmx-\d+\.\d+\.\d+\.min\.js$/);
    const res = await appWithHeaders().request(HTMX_PATH);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("javascript");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(await res.text()).toContain("htmx");
  });

  it("is cacheable for a year, also for a logged-in browser", async () => {
    const res = await appWithHeaders().request(HTMX_PATH, {
      headers: { cookie: "runway_session=abc" },
    });
    expect(res.headers.get("cache-control")).toContain("immutable");
    expect(res.headers.get("cache-control")).not.toContain("no-store");
  });

  it("publishes an SRI hash that matches the bytes it serves", async () => {
    const res = await appWithHeaders().request(HTMX_PATH);
    const bytes = Buffer.from(await res.arrayBuffer());
    const sri = `sha384-${createHash("sha384").update(bytes).digest("base64")}`;
    expect(HTMX_INTEGRITY).toBe(sri);
  });

  it("does not serve other asset paths", async () => {
    const res = await appWithHeaders().request("/assets/../../etc/passwd");
    expect(res.status).toBe(404);
  });

  it("no longer allows third-party scripts in the CSP", async () => {
    const res = await appWithHeaders().request(HTMX_PATH);
    const csp = res.headers.get("content-security-policy") ?? "";
    expect(csp).toContain("script-src 'self'");
    expect(csp).not.toContain("unpkg.com");
  });
});
