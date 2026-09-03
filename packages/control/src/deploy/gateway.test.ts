import { describe, it, expect } from "vitest";
import { buildAppRouteDoc, type AppRouteConfig } from "./gateway.js";

function baseCfg(over: Partial<AppRouteConfig> = {}): AppRouteConfig {
  return {
    appId: "abc123",
    containerName: "runway-app-abc123",
    domain: "example.test",
    port: 80,
    ...over,
  };
}

function routers(cfg: AppRouteConfig): Record<string, any> {
  return (buildAppRouteDoc(cfg) as any).http.routers;
}

function blockRule(cfg: AppRouteConfig): string {
  return routers(cfg)["app-abc123-blockmeta"].rule;
}

/**
 * Pull the PathRegexp(`...`) arguments back out of a Traefik rule so
 * the patterns themselves can be exercised against real paths. A
 * pattern that silently degrades (a lost backslash turning `\.` into
 * "any character") still produces a perfectly valid rule string, so
 * asserting on the rule text alone would not catch it.
 */
function pathRegexps(rule: string): RegExp[] {
  const out: RegExp[] = [];
  const re = /PathRegexp\(`([^`]+)`\)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(rule)) !== null) out.push(new RegExp(m[1]));
  return out;
}

function blockedBy(rule: string, path: string): boolean {
  return pathRegexps(rule).some((re) => re.test(path));
}

describe("buildAppRouteDoc — app routing", () => {
  it("routes the app domain to its own service", () => {
    const r = routers(baseCfg());
    expect(r["app-abc123"].rule).toBe("Host(`example.test`)");
    expect(r["app-abc123"].service).toBe("app-abc123");
  });

  it("includes a custom domain in the host rule", () => {
    const r = routers(baseCfg({ customDomain: "www.example.test" }));
    expect(r["app-abc123"].rule).toBe(
      "Host(`example.test`) || Host(`www.example.test`)"
    );
  });

  it("attaches basicAuth only when configured and SSO is off", () => {
    const withAuth = buildAppRouteDoc(
      baseCfg({ basicAuth: { htpasswd: "u:$2y$hash" } })
    ) as any;
    expect(withAuth.http.routers["app-abc123"].middlewares).toEqual([
      "app-abc123-basicauth",
    ]);

    const ssoWins = buildAppRouteDoc(
      baseCfg({ basicAuth: { htpasswd: "u:$2y$hash" }, ssoEnabled: true })
    ) as any;
    expect(ssoWins.http.routers["app-abc123"].middlewares).toEqual([
      "app-abc123-forwardauth",
    ]);
  });
});

describe("buildAppRouteDoc — build-metadata block", () => {
  it("denies via an ipAllowList that can never match a source", () => {
    const doc = buildAppRouteDoc(baseCfg()) as any;
    const router = doc.http.routers["app-abc123-blockmeta"];
    expect(router.middlewares).toEqual(["app-abc123-denyall"]);
    expect(doc.http.middlewares["app-abc123-denyall"]).toEqual({
      ipAllowList: { sourceRange: ["255.255.255.255/32"] },
    });
  });

  it("outranks the app's own router", () => {
    const r = routers(baseCfg());
    expect(r["app-abc123-blockmeta"].priority).toBeGreaterThan(1000);
    expect(r["app-abc123"].priority).toBeUndefined();
  });

  it("covers the custom domain too", () => {
    const rule = blockRule(baseCfg({ customDomain: "www.example.test" }));
    expect(rule).toContain("Host(`example.test`)");
    expect(rule).toContain("Host(`www.example.test`)");
  });

  it("uses no lookahead — Traefik matchers are Go RE2", () => {
    // RE2 rejects (?!...) and (?=...) outright, which would take the
    // whole router down and, with it, ACME renewal for the app.
    expect(blockRule(baseCfg())).not.toMatch(/\(\?[=!]/);
  });

  it("carves out .well-known with Traefik's ! operator", () => {
    expect(blockRule(baseCfg())).toContain("!PathPrefix(`/.well-known/`)");
  });

  it("blocks build metadata and dotfiles", () => {
    const rule = blockRule(baseCfg());
    for (const p of [
      "/Dockerfile",
      "/sub/Dockerfile",
      "/.env",
      "/.gitignore",
      "/.github/workflows/deploy.yml",
      "/nested/.env",
      "/README.md",
      "/CLAUDE.md",
      "/AGENTS.md",
      "/HISTORY.md",
    ]) {
      expect(blockedBy(rule, p), `should block ${p}`).toBe(true);
    }
  });

  it("leaves ordinary site paths alone", () => {
    const rule = blockRule(baseCfg());
    for (const p of [
      "/",
      "/index.html",
      "/nav.js",
      "/robots.txt",
      "/sitemap.xml",
      "/assets/logo.svg",
      "/assets/img/hero.v2.png",
      "/clients/homepage/",
      "/docs/readme.html",
      "/Dockerfile.md.html",
    ]) {
      expect(blockedBy(rule, p), `should allow ${p}`).toBe(false);
    }
  });
});
