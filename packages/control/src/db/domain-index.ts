import type { DatabaseSync } from "node:sqlite";

/**
 * Hostname uniqueness for apps (S03). Two apps must never answer to the
 * same Host: Traefik would give both routers the same rule and the second
 * writer would take over the first app's traffic (and forward-auth would
 * apply the wrong app's SSO policy).
 *
 * The rule is enforced twice: in code (routes check before they write) and
 * here with unique indexes as a backstop. The indexes cannot be forced on
 * an installation that already has duplicates (the migration would fail
 * and the control plane would not start), and the duplicates must not be
 * deleted either (that would take an app offline). So a column that holds
 * duplicates gets no index, the duplicates are logged and audited, and the
 * code check keeps new ones from appearing. Once the administrator has
 * renamed the apps, the next start creates the index by itself.
 */

export interface DomainDuplicate {
  host: string;
  appIds: string[];
}

interface Row {
  id: string;
  domain: string | null;
  custom_domain: string | null;
}

export function normalizeHost(raw: string): string {
  return raw.trim().toLowerCase().replace(/\.+$/, "");
}

/** Hostnames claimed by more than one app, across both columns. */
export function findDomainDuplicates(db: DatabaseSync): DomainDuplicate[] {
  const rows = db
    .prepare(`SELECT id, domain, custom_domain FROM apps`)
    .all() as unknown as Row[];
  const byHost = new Map<string, Set<string>>();
  for (const r of rows) {
    for (const raw of [r.domain, r.custom_domain]) {
      if (!raw) continue;
      const host = normalizeHost(raw);
      if (!host) continue;
      if (!byHost.has(host)) byHost.set(host, new Set());
      byHost.get(host)!.add(r.id);
    }
  }
  return [...byHost.entries()]
    .filter(([, ids]) => ids.size > 1)
    .map(([host, ids]) => ({ host, appIds: [...ids].sort() }))
    .sort((a, b) => a.host.localeCompare(b.host));
}

function columnHasDuplicates(db: DatabaseSync, column: "domain" | "custom_domain"): boolean {
  const row = db
    .prepare(
      `SELECT 1 AS dup FROM apps
        WHERE ${column} IS NOT NULL AND ${column} != ''
        GROUP BY lower(${column}) HAVING COUNT(*) > 1 LIMIT 1`
    )
    .get();
  return !!row;
}

export interface DomainIndexResult {
  created: string[];
  skipped: string[];
  duplicates: DomainDuplicate[];
}

/**
 * Create the unique indexes where possible; report what could not be
 * done. Safe to run on every start.
 */
export function ensureUniqueDomainIndexes(db: DatabaseSync): DomainIndexResult {
  const created: string[] = [];
  const skipped: string[] = [];
  for (const column of ["domain", "custom_domain"] as const) {
    const name = `idx_apps_${column}_unique`;
    const exists = db
      .prepare(`SELECT 1 FROM sqlite_master WHERE type = 'index' AND name = ?`)
      .get(name);
    if (exists) continue;
    if (columnHasDuplicates(db, column)) {
      skipped.push(column);
      continue;
    }
    db.exec(
      `CREATE UNIQUE INDEX ${name} ON apps(lower(${column}))
         WHERE ${column} IS NOT NULL AND ${column} != ''`
    );
    created.push(column);
  }

  const duplicates = findDomainDuplicates(db);
  if (duplicates.length > 0) {
    const detail = duplicates
      .map((d) => `${d.host}: ${d.appIds.join(", ")}`)
      .join("; ");
    console.warn(
      `[runway] ${duplicates.length} hostname(s) are claimed by more than one app: ${detail}. ` +
        `Rename or reconfigure the apps so each has its own domain; until then the ` +
        `domain uniqueness index is not enforced for the affected column.`
    );
    // One audit line per distinct finding, not one per start.
    const last = db
      .prepare(
        `SELECT detail FROM audit_log WHERE action = 'domain_duplicates_detected'
          ORDER BY id DESC LIMIT 1`
      )
      .get() as { detail: string | null } | undefined;
    if (last?.detail !== detail) {
      db.prepare(
        `INSERT INTO audit_log (user_id, username, action, detail)
         VALUES ('system', 'system', 'domain_duplicates_detected', ?)`
      ).run(detail);
    }
  }
  return { created, skipped, duplicates };
}
