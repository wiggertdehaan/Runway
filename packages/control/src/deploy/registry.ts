import { assertSafeOutboundUrl, type SsrfCheckResult } from "../util/ssrf-guard.js";
import { parseExactTag, type ImageRef, type TagSource } from "./base-images.js";

/**
 * Anonymous tag listing for base-image patch lookups.
 *
 * The registry host comes from a tenant's Dockerfile, so it is user
 * input: every URL we fetch (registry, token realm, pagination links)
 * goes through the SSRF guard first (https only, no private targets),
 * with short timeouts and a response-size cap. Docker Hub gets a
 * name-filtered query through its web API because `library/nginx`
 * has thousands of tags; everything else uses the OCI distribution
 * `tags/list` endpoint with the standard anonymous Bearer flow.
 */

const TIMEOUT_MS = 10_000;
const MAX_BODY_BYTES = 5 * 1024 * 1024;
const MAX_PAGES = 10;
const MAX_TAGS = 20_000;
const CACHE_TTL_MS = 10 * 60 * 1000;

type Guard = (url: string) => Promise<SsrfCheckResult>;

export interface RegistryDeps {
  fetchFn?: typeof fetch;
  guard?: Guard;
  now?: () => number;
}

class RegistryError extends Error {}

async function getJson(
  url: string,
  deps: Required<RegistryDeps>,
  headers: Record<string, string> = {}
): Promise<{ status: number; json: any; headers: Headers }> {
  const check = await deps.guard(url);
  if (!check.ok) throw new RegistryError(`blocked outbound URL (${check.error})`);
  const res = await deps.fetchFn(url, {
    headers: { accept: "application/json", ...headers },
    signal: AbortSignal.timeout(TIMEOUT_MS),
    redirect: "error",
  });
  const len = parseInt(res.headers.get("content-length") ?? "0", 10);
  if (len > MAX_BODY_BYTES) throw new RegistryError("response too large");
  let json: any = null;
  if (res.status === 200) {
    const text = await res.text();
    if (text.length > MAX_BODY_BYTES) throw new RegistryError("response too large");
    json = JSON.parse(text);
  }
  return { status: res.status, json, headers: res.headers };
}

async function hubTags(ref: ImageRef, filter: string, deps: Required<RegistryDeps>): Promise<string[]> {
  const tags: string[] = [];
  let url: string | null =
    `https://hub.docker.com/v2/repositories/${ref.repo}/tags?page_size=100&name=${encodeURIComponent(filter)}`;
  for (let page = 0; url && page < MAX_PAGES; page++) {
    const { status, json } = await getJson(url, deps);
    if (status !== 200) throw new RegistryError(`Docker Hub HTTP ${status}`);
    for (const r of json?.results ?? []) if (typeof r?.name === "string") tags.push(r.name);
    const next: unknown = json?.next;
    url = typeof next === "string" && next.startsWith("https://hub.docker.com/") ? next : null;
  }
  return tags;
}

function parseBearer(header: string | null): { realm: string; service?: string; scope?: string } | null {
  if (!header || !/^bearer\s/i.test(header)) return null;
  const params: Record<string, string> = {};
  for (const m of header.matchAll(/(\w+)="([^"]*)"/g)) params[m[1]] = m[2];
  return params.realm ? { realm: params.realm, service: params.service, scope: params.scope } : null;
}

async function ociTags(ref: ImageRef, deps: Required<RegistryDeps>): Promise<string[]> {
  const host = ref.registry === "docker.io" ? "registry-1.docker.io" : ref.registry;
  const base = `https://${host}`;
  let url: string | null = `${base}/v2/${ref.repo}/tags/list?n=1000`;
  let token: string | null = null;
  const tags: string[] = [];

  for (let page = 0; url && page < MAX_PAGES && tags.length < MAX_TAGS; page++) {
    let res = await getJson(url, deps, token ? { authorization: `Bearer ${token}` } : {});
    if (res.status === 401 && !token) {
      const b = parseBearer(res.headers.get("www-authenticate"));
      if (!b) throw new RegistryError("registry requires non-anonymous auth");
      const q = new URLSearchParams();
      if (b.service) q.set("service", b.service);
      q.set("scope", b.scope ?? `repository:${ref.repo}:pull`);
      const t = await getJson(`${b.realm}${b.realm.includes("?") ? "&" : "?"}${q}`, deps);
      token = t.json?.token ?? t.json?.access_token ?? null;
      if (t.status !== 200 || !token) throw new RegistryError("anonymous token request failed");
      res = await getJson(url, deps, { authorization: `Bearer ${token}` });
    }
    if (res.status !== 200) throw new RegistryError(`registry HTTP ${res.status}`);
    for (const t of res.json?.tags ?? []) if (typeof t === "string") tags.push(t);
    const link = res.headers.get("link");
    const next = link ? /<([^>]+)>\s*;\s*rel="?next"?/i.exec(link)?.[1] : undefined;
    url = next ? new URL(next, base).toString() : null;
    if (url && new URL(url).host !== host) url = null; // never follow off-registry
  }
  return tags;
}

export function createTagSource(deps: RegistryDeps = {}): TagSource {
  const d: Required<RegistryDeps> = {
    fetchFn: deps.fetchFn ?? fetch,
    guard: deps.guard ?? assertSafeOutboundUrl,
    now: deps.now ?? Date.now,
  };
  const cache = new Map<string, { at: number; tags: string[] }>();

  return async (ref: ImageRef): Promise<string[]> => {
    const exact = ref.tag ? parseExactTag(ref.tag) : null;
    const filter = exact ? `${exact.prefix}${exact.major}.${exact.minor}.` : "";
    const key = `${ref.registry}/${ref.repo}/${filter}`;
    const hit = cache.get(key);
    if (hit && d.now() - hit.at < CACHE_TTL_MS) return hit.tags;

    let tags: string[];
    if (ref.registry === "docker.io" && filter) {
      try {
        tags = await hubTags(ref, filter, d);
      } catch {
        tags = await ociTags(ref, d); // Hub web API unavailable: registry API
      }
    } else {
      tags = await ociTags(ref, d);
    }
    cache.set(key, { at: d.now(), tags });
    return tags;
  };
}
