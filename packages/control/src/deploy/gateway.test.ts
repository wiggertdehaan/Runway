import { describe, it, expect } from "vitest";
import { buildAppRouteDoc, buildDashboardRouteDoc, buildMaintenanceRouteDoc, type AppRouteConfig } from "./gateway.js";

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
      "app-abc123-stripuser",
      "app-abc123-basicauth",
    ]);

    const ssoWins = buildAppRouteDoc(
      baseCfg({ basicAuth: { htpasswd: "u:$2y$hash" }, ssoEnabled: true })
    ) as any;
    expect(ssoWins.http.routers["app-abc123"].middlewares).toEqual([
      "app-abc123-stripuser",
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

describe("buildAppRouteDoc — SSO covers every hostname (S05)", () => {
  const sso = { ssoEnabled: true, customDomain: "www.example.test" };

  it("puts forwardAuth on one router that matches both hosts", () => {
    const r = routers(baseCfg(sso));
    expect(r["app-abc123"].rule).toBe(
      "Host(`example.test`) || Host(`www.example.test`)"
    );
    expect(r["app-abc123"].middlewares).toEqual([
      "app-abc123-stripuser",
      "app-abc123-forwardauth",
    ]);
  });

  it("has no router for the custom domain without the middleware", () => {
    const r = routers(baseCfg(sso));
    expect(r["app-abc123-custom"]).toBeUndefined();
    for (const [key, router] of Object.entries(r)) {
      if (key.endsWith("-blockmeta")) continue; // 403s everything it matches
      if (String(router.rule).includes("www.example.test")) {
        expect(router.middlewares).toContain("app-abc123-forwardauth");
      }
    }
  });

  it("still lists both hosts for the certificate", () => {
    const r = routers(baseCfg(sso));
    expect(r["app-abc123"].tls.domains).toEqual([
      { main: "example.test" },
      { main: "www.example.test" },
    ]);
  });

  it("leaves non-SSO apps without forwardAuth, with or without a custom domain", () => {
    for (const customDomain of [null, "www.example.test"]) {
      const doc = buildAppRouteDoc(baseCfg({ customDomain })) as any;
      expect(doc.http.routers["app-abc123"].middlewares).toEqual(["app-abc123-stripuser"]);
      expect(doc.http.middlewares["app-abc123-forwardauth"]).toBeUndefined();
    }
  });

  it("defines the forwardAuth middleware it references", () => {
    const doc = buildAppRouteDoc(baseCfg(sso)) as any;
    expect(doc.http.middlewares["app-abc123-forwardauth"].forwardAuth.address).toBe(
      "http://control:3000/auth/verify"
    );
  });
});

describe("X-Forwarded-User cannot be forged by a visitor (S23)", () => {
  const cases: Array<[string, Partial<AppRouteConfig>]> = [
    ["a plain app", {}],
    ["an app with a custom domain", { customDomain: "www.example.test" }],
    ["an app with basic auth", { basicAuth: { htpasswd: "u:$2y$hash" } }],
    ["an SSO app", { ssoEnabled: true }],
    ["an SSO app with a custom domain", { ssoEnabled: true, customDomain: "www.example.test" }],
  ];

  for (const [label, over] of cases) {
    it(`drops the client's header before anything else on ${label}`, () => {
      const doc = buildAppRouteDoc(baseCfg(over)) as any;
      const router = doc.http.routers["app-abc123"];
      // First in the chain, so nothing downstream ever sees the client's value.
      expect(router.middlewares[0]).toBe("app-abc123-stripuser");
      // An empty value is how Traefik deletes a request header.
      expect(doc.http.middlewares["app-abc123-stripuser"]).toEqual({
        headers: { customRequestHeaders: { "X-Forwarded-User": "" } },
      });
    });
  }

  it("still lets forwardAuth set the header for an SSO app, after the strip", () => {
    const doc = buildAppRouteDoc(baseCfg({ ssoEnabled: true })) as any;
    expect(doc.http.routers["app-abc123"].middlewares).toEqual([
      "app-abc123-stripuser",
      "app-abc123-forwardauth",
    ]);
    expect(doc.http.middlewares["app-abc123-forwardauth"].forwardAuth.authResponseHeaders).toEqual([
      "X-Forwarded-User",
    ]);
  });

  it("every middleware a router lists is defined", () => {
    for (const [, over] of cases) {
      const doc = buildAppRouteDoc(baseCfg(over)) as any;
      for (const router of Object.values<any>(doc.http.routers)) {
        for (const name of router.middlewares ?? []) {
          expect(doc.http.middlewares[name], name).toBeDefined();
        }
      }
    }
  });
});

describe("dashboard route keeps Traefik's own endpoints off the public address (S23)", () => {
  const doc = buildDashboardRouteDoc("runway.example.com") as any;

  it("still routes the dashboard host to control", () => {
    expect(doc.http.routers.control.rule).toBe("Host(`runway.example.com`)");
    expect(doc.http.routers.control.service).toBe("control");
    expect(doc.http.routers.control.priority).toBeUndefined();
  });

  it("denies /auth/verify and /maintenance on the dashboard host, with a higher priority", () => {
    const r = doc.http.routers["control-internal"];
    expect(r.rule).toBe(
      "Host(`runway.example.com`) && (Path(`/auth/verify`) || Path(`/maintenance`))"
    );
    expect(r.priority).toBeGreaterThan(1000);
    expect(r.middlewares).toEqual(["control-internal-deny"]);
    expect(doc.http.middlewares["control-internal-deny"]).toEqual({
      ipAllowList: { sourceRange: ["255.255.255.255/32"] },
    });
  });

  it("does not touch the service URL Traefik's forwardAuth and the quarantine rewrite use", () => {
    expect(doc.http.services.control.loadBalancer.servers).toEqual([{ url: "http://control:3000" }]);
    const sso = buildAppRouteDoc(baseCfg({ ssoEnabled: true })) as any;
    expect(sso.http.middlewares["app-abc123-forwardauth"].forwardAuth.address).toBe(
      "http://control:3000/auth/verify"
    );
    const q = buildMaintenanceRouteDoc({ appId: "abc123", domain: "example.test" }) as any;
    expect(q.http.services["app-abc123-maintenance"].loadBalancer.servers).toEqual([
      { url: "http://control:3000" },
    ]);
  });

  it("every middleware it lists is defined", () => {
    for (const router of Object.values<any>(doc.http.routers)) {
      for (const name of router.middlewares ?? []) expect(doc.http.middlewares[name]).toBeDefined();
    }
  });
});
