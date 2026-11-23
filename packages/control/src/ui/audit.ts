/**
 * The audit page as pure functions: a filter (everyone / people / API and MCP /
 * refused) and the table rows. Lines written by an API key or the MCP route
 * carry an actor, a result and a source address; refused attempts carry a
 * count ("x37") because many refusals from one source in one window are one
 * row. Everything user-influenced is escaped here.
 */

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export type AuditFilterKey = "all" | "people" | "api" | "denied";

export const AUDIT_FILTERS: ReadonlyArray<{ key: AuditFilterKey; label: string }> = [
  { key: "all", label: "Everything" },
  { key: "people", label: "People" },
  { key: "api", label: "API and MCP" },
  { key: "denied", label: "Refused" },
];

/** Anything unknown falls back to "all". */
export function parseAuditFilter(value: string | undefined | null): AuditFilterKey {
  return AUDIT_FILTERS.some((f) => f.key === value) ? (value as AuditFilterKey) : "all";
}

export function renderAuditFilters(active: AuditFilterKey): string {
  const links = AUDIT_FILTERS.map(
    (f) =>
      `<a class="chip" href="/audit${f.key === "all" ? "" : `?type=${f.key}`}" aria-current="${f.key === active ? "page" : "false"}">${escapeHtml(f.label)}</a>`
  ).join(" ");
  return `<div class="chips" role="navigation" aria-label="Filter the audit log">${links}</div>`;
}

export interface AuditRowInput {
  created_at: string;
  username: string;
  action: string;
  target_username: string | null;
  detail: string | null;
  actor_type: string | null;
  app_id: string | null;
  result: string | null;
  source_ip: string | null;
  count: number | null;
}

const RESULT_TONE: Record<string, string> = {
  ok: "tag-ok",
  rejected: "tag-warn",
  denied: "tag-err",
  error: "tag-err",
};

function resultTag(result: string | null): string {
  if (!result) return "";
  const tone = RESULT_TONE[result] ?? "";
  return `<span class="tag ${tone}">${escapeHtml(result)}</span> `;
}

function actorCell(e: AuditRowInput): string {
  const name = escapeHtml(e.username);
  if (!e.actor_type) return name;
  const kind = e.actor_type === "api-key" ? "API key" : e.actor_type === "mcp" ? "MCP" : "Unknown caller";
  return `${name} <span class="meta">${escapeHtml(kind)}</span>`;
}

function detailCell(e: AuditRowInput): string {
  const bits: string[] = [];
  if (e.detail) bits.push(escapeHtml(e.detail));
  if (e.actor_type && e.source_ip) {
    bits.push(`from ${e.source_ip === "*" ? "many sources" : escapeHtml(e.source_ip)}`);
  }
  if (e.count && e.count > 1) bits.push(`&times;${e.count}`);
  return bits.length ? bits.join(" ") : "&mdash;";
}

export function renderAuditRows(entries: AuditRowInput[]): string {
  return entries
    .map((e) => {
      const target = e.target_username
        ? escapeHtml(e.target_username)
        : e.app_id
          ? `<a href="/apps/${encodeURIComponent(e.app_id)}">${escapeHtml(e.app_id)}</a>`
          : '<span class="meta">&mdash;</span>';
      return `
        <tr>
          <td class="meta">${escapeHtml(e.created_at)}</td>
          <td>${actorCell(e)}</td>
          <td>${resultTag(e.result)}<code>${escapeHtml(e.action)}</code></td>
          <td>${target}</td>
          <td class="meta">${detailCell(e)}</td>
        </tr>`;
    })
    .join("");
}
