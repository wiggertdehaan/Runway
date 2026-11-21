import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Finding } from "./scan.js";

/**
 * CISA Known Exploited Vulnerabilities catalog. Trivy's JSON does not
 * flag KEV membership, so we fetch the public CISA feed (fixed URL, no
 * user input) and match on CVE id. The list is cached on disk next to
 * the DB for 24h; if CISA is unreachable we fall back to a stale copy
 * rather than silently treating "no data" as "no exploited CVEs".
 */

export const KEV_URL =
  "https://www.cisa.gov/sites/default/files/feeds/known_exploited_vulnerabilities.json";
const DB_PATH = process.env.DB_PATH || join(process.cwd(), "runway.db");
const CACHE_PATH = process.env.KEV_CACHE_PATH || join(dirname(DB_PATH), "kev.json");
const TTL_MS = 24 * 60 * 60 * 1000;

export interface KevList {
  ids: Set<string>;
  /** ISO time the list was fetched, null if never available. */
  fetchedAt: string | null;
  /** True when the list could not be refreshed and may be old/empty. */
  stale: boolean;
}

/** Pure: extract CVE ids from the CISA feed JSON. */
export function parseKevFeed(raw: unknown): Set<string> {
  const ids = new Set<string>();
  const list = (raw as { vulnerabilities?: Array<{ cveID?: unknown }> })
    ?.vulnerabilities;
  if (!Array.isArray(list)) return ids;
  for (const v of list) {
    if (typeof v?.cveID === "string") ids.add(v.cveID.toUpperCase());
  }
  return ids;
}

/** Pure: findings whose CVE is on the KEV list (deduped by id). */
export function kevFindings(findings: Finding[], kev: Set<string>): Finding[] {
  const seen = new Set<string>();
  const out: Finding[] = [];
  for (const f of findings) {
    const id = f.id.toUpperCase();
    if (f.source !== "image" || !kev.has(id) || seen.has(id)) continue;
    seen.add(id);
    out.push(f);
  }
  return out;
}

interface CacheFile {
  fetchedAt: string;
  ids: string[];
}

function readCache(): CacheFile | null {
  try {
    if (!existsSync(CACHE_PATH)) return null;
    const parsed = JSON.parse(readFileSync(CACHE_PATH, "utf8")) as CacheFile;
    if (!Array.isArray(parsed.ids) || typeof parsed.fetchedAt !== "string") return null;
    return parsed;
  } catch {
    return null;
  }
}

function writeCache(c: CacheFile): void {
  try {
    mkdirSync(dirname(CACHE_PATH), { recursive: true });
    const tmp = `${CACHE_PATH}.tmp`;
    writeFileSync(tmp, JSON.stringify(c));
    renameSync(tmp, CACHE_PATH);
  } catch {
    /* cache is an optimisation only */
  }
}

export async function getKevList(
  fetchFn: typeof fetch = fetch
): Promise<KevList> {
  const cached = readCache();
  if (cached && Date.now() - Date.parse(cached.fetchedAt) < TTL_MS) {
    return { ids: new Set(cached.ids), fetchedAt: cached.fetchedAt, stale: false };
  }
  try {
    const res = await fetchFn(KEV_URL, { signal: AbortSignal.timeout(20_000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const ids = parseKevFeed(await res.json());
    if (ids.size === 0) throw new Error("feed contained no CVEs");
    const fetchedAt = new Date().toISOString();
    writeCache({ fetchedAt, ids: [...ids] });
    return { ids, fetchedAt, stale: false };
  } catch {
    if (cached) {
      return { ids: new Set(cached.ids), fetchedAt: cached.fetchedAt, stale: true };
    }
    return { ids: new Set(), fetchedAt: null, stale: true };
  }
}
