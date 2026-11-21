import { describe, it, expect } from "vitest";
import { createTagSource } from "./registry.js";
import { parseImageRef } from "./base-images.js";

const ok = async () => ({ ok: true as const });
type Handler = (url: string, init?: RequestInit) => { status?: number; body?: unknown; headers?: Record<string, string | undefined> };

function fakeFetch(h: Handler) {
  const urls: string[] = [];
  const fn = (async (url: string, init?: RequestInit) => {
    urls.push(url);
    const r = h(url, init);
    return new Response(r.body === undefined ? null : JSON.stringify(r.body), {
      status: r.status ?? 200,
      headers: r.headers as Record<string, string> | undefined,
    });
  }) as unknown as typeof fetch;
  return { fn, urls };
}

const nginx = parseImageRef("nginx:1.30.6-alpine")!;

describe("createTagSource", () => {
  it("Docker Hub: name-filtered query, follows next, collects names", async () => {
    const { fn, urls } = fakeFetch((u) =>
      u.includes("page=2")
        ? { body: { results: [{ name: "1.30.7-alpine" }], next: null } }
        : { body: { results: [{ name: "1.30.6-alpine" }], next: "https://hub.docker.com/v2/repositories/library/nginx/tags?page=2" } }
    );
    const tags = await createTagSource({ fetchFn: fn, guard: ok })(nginx);
    expect(tags).toEqual(["1.30.6-alpine", "1.30.7-alpine"]);
    expect(urls[0]).toContain("/v2/repositories/library/nginx/tags");
    expect(urls[0]).toContain("name=1.30.");
  });

  it("never follows a Hub 'next' that leaves hub.docker.com", async () => {
    const { fn, urls } = fakeFetch(() => ({ body: { results: [{ name: "1.30.7-alpine" }], next: "https://evil.example/x" } }));
    await createTagSource({ fetchFn: fn, guard: ok })(nginx);
    expect(urls).toHaveLength(1);
  });

  it("falls back to the registry API when the Hub API fails", async () => {
    const { fn, urls } = fakeFetch((u) =>
      u.startsWith("https://hub.docker.com/") ? { status: 500 } : { body: { tags: ["1.30.7-alpine"] } }
    );
    const tags = await createTagSource({ fetchFn: fn, guard: ok })(nginx);
    expect(tags).toEqual(["1.30.7-alpine"]);
    expect(urls.some((u) => u.startsWith("https://registry-1.docker.io/v2/library/nginx/tags/list"))).toBe(true);
  });

  it("OCI: anonymous bearer flow and Link pagination", async () => {
    const ref = parseImageRef("ghcr.io/o/r:1.2.3")!;
    const { fn, urls } = fakeFetch((u, init) => {
      const auth = (init?.headers as Record<string, string> | undefined)?.authorization;
      if (u.startsWith("https://ghcr.io/token")) return { body: { token: "T" } };
      if (!auth) {
        return { status: 401, headers: { "www-authenticate": 'Bearer realm="https://ghcr.io/token",service="ghcr.io",scope="repository:o/r:pull"' } };
      }
      if (u.includes("last=")) return { body: { tags: ["1.2.5"] } };
      return { body: { tags: ["1.2.3", "1.2.4"] }, headers: { link: '</v2/o/r/tags/list?n=1000&last=1.2.4>; rel="next"' } };
    });
    const tags = await createTagSource({ fetchFn: fn, guard: ok })(ref);
    expect(tags).toEqual(["1.2.3", "1.2.4", "1.2.5"]);
    expect(urls.some((u) => u.startsWith("https://ghcr.io/token?service=ghcr.io"))).toBe(true);
  });

  it("refuses URLs rejected by the SSRF guard (e.g. internal registry hosts)", async () => {
    const { fn, urls } = fakeFetch(() => ({ body: { tags: [] } }));
    const guard = async () => ({ ok: false as const, error: "private_target" as const });
    await expect(createTagSource({ fetchFn: fn, guard })(parseImageRef("10.0.0.5:5000/x:1.2.3")!)).rejects.toThrow(/blocked outbound/);
    expect(urls).toHaveLength(0);
  });

  it("does not follow Link pagination to another host", async () => {
    const ref = parseImageRef("quay.io/o/r:1.2.3")!;
    const { fn, urls } = fakeFetch(() => ({ body: { tags: ["1.2.4"] }, headers: { link: '<https://evil.example/v2/x>; rel="next"' } }));
    await createTagSource({ fetchFn: fn, guard: ok })(ref);
    expect(urls).toHaveLength(1);
  });

  it("caches per repo+minor for 10 minutes", async () => {
    let t = 0;
    const { fn, urls } = fakeFetch(() => ({ body: { results: [{ name: "1.30.7-alpine" }], next: null } }));
    const src = createTagSource({ fetchFn: fn, guard: ok, now: () => t });
    await src(nginx);
    await src(nginx);
    expect(urls).toHaveLength(1);
    t = 11 * 60 * 1000;
    await src(nginx);
    expect(urls).toHaveLength(2);
  });
});
