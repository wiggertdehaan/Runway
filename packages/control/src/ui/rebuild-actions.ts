/**
 * The two buttons on the Rebuild page, and what they would touch.
 *
 * "Rebuild apps with issues" is the one to press: the same selection as
 * the weekly run (actively exploited CVE, critical with a fix, dependency
 * updates, quarantine), but apps that switched automatic rebuild off are
 * included, because a person is asking. "Rebuild all apps" is the second,
 * quieter button and asks for a confirmation inside the page: a <details>
 * panel that works without JavaScript (no confirm() dialog). The server
 * enforces the same two rules again, so a crafted POST gets nothing the
 * page would not have offered.
 *
 * Pure rendering over plain data: no database, Docker or network.
 */

export interface IssueRow {
  id: string;
  name: string;
  reason: string;
  /** Automatic rebuild is off for this app: the weekly run skips it. */
  optedOut: boolean;
  quarantined: boolean;
}

export interface AllRow {
  id: string;
  name: string;
}

export interface ActionsInput {
  issues: IssueRow[];
  all: AllRow[];
  /** A run is busy: both buttons are off. */
  running: boolean;
  /** Open the confirmation panel for "all" (the server sends you there). */
  confirmAll: boolean;
  /** The KEV list could not be refreshed: the selection may miss apps. */
  kevStale: boolean;
}

/** Names shown before the rest folds into "and N more". */
export const LIST_PREVIEW = 6;

function esc(v: string): string {
  return v
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

const plural = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`;

/** Text of the primary button: says what it will do, or why it cannot. */
export function issuesButtonLabel(issueCount: number, running: boolean): string {
  if (running) return "Run in progress…";
  if (issueCount === 0) return "Nothing needs a rebuild";
  return `Rebuild ${plural(issueCount, "app", "apps")} with issues`;
}

function appLink(id: string, name: string): string {
  return `<a href="/apps/${encodeURIComponent(id)}">${esc(name)}</a>`;
}

function issueItem(r: IssueRow): string {
  const tags = [
    r.quarantined ? '<span class="tag tag-err">Offline</span>' : "",
    r.optedOut ? '<span class="tag" title="Automatic rebuild is off for this app, so the weekly run skips it">Not rebuilt automatically</span>' : "",
  ]
    .filter(Boolean)
    .join(" ");
  return `<li class="rr-sel-item">${appLink(r.id, r.name)} <span class="rr-why">${esc(r.reason)}</span>${tags ? ` ${tags}` : ""}</li>`;
}

function listWithMore(items: string[], noun: string): string {
  const head = items.slice(0, LIST_PREVIEW).join("");
  const rest = items.slice(LIST_PREVIEW);
  const more = rest.length
    ? `<li class="rr-sel-more"><details class="rr-more"><summary>and ${rest.length} more ${noun}</summary><ul class="rr-sel">${rest.join("")}</ul></details></li>`
    : "";
  return `<ul class="rr-sel">${head}${more}</ul>`;
}

export function renderIssuesAction(input: ActionsInput): string {
  const n = input.issues.length;
  const disabled = input.running || n === 0;
  const label = issuesButtonLabel(n, input.running);
  const lead =
    n === 0
      ? '<p class="meta rr-act-lead">No app has an actively exploited vulnerability, a critical finding with a fix, or dependency updates waiting. The weekly run would skip them all as well.</p>'
      : `<p class="meta rr-act-lead">${plural(n, "app", "apps")} would be rebuilt, one after another. Same selection as the weekly run, plus apps that have automatic rebuild switched off.</p>`;
  const list = n > 0 ? listWithMore(input.issues.map(issueItem), "apps") : "";
  const stale = input.kevStale
    ? '<p class="meta rr-stale">The list of actively exploited CVEs could not be refreshed just now, so this selection may be incomplete.</p>'
    : "";
  return `<div class="rr-act" data-act="issues" data-count="${n}">
    <form method="POST" action="/rebuild/run">
      <input type="hidden" name="mode" value="issues" />
      <button type="submit"${disabled ? " disabled" : ""}>${esc(label)}</button>
    </form>
    ${lead}
    ${list}
    ${stale}
  </div>`;
}

export function renderAllAction(input: ActionsInput): string {
  const n = input.all.length;
  if (input.running || n === 0) {
    const label = input.running ? "Run in progress…" : "Rebuild all apps";
    const why = input.running ? "" : '<p class="meta rr-act-lead">No app has been deployed yet, so there is nothing to rebuild.</p>';
    return `<div class="rr-act rr-act-all" data-act="all" data-count="${n}">
      <button type="button" class="ghost" disabled>${label}</button>
      ${why}
    </div>`;
  }
  const withIssues = input.issues.length;
  const without = n - withIssues;
  const names = listWithMore(
    input.all.map((a) => `<li class="rr-sel-item">${appLink(a.id, a.name)}</li>`),
    "apps"
  );
  return `<details class="rr-all rr-act rr-act-all" data-act="all" data-count="${n}"${input.confirmAll ? " open" : ""}>
    <summary class="rr-all-sum">Rebuild all apps</summary>
    <div class="rr-all-body">
      <p class="rr-all-warn"><strong>Rebuild all ${plural(n, "app", "apps")}?</strong> That includes ${without} that ${without === 1 ? "has" : "have"} no issues. Every build is a full build without cache, one after another, so this can take a while and uses the server's memory and disk.</p>
      ${names}
      <form method="POST" action="/rebuild/run" class="rr-all-form">
        <input type="hidden" name="mode" value="all" />
        <input type="hidden" name="confirm" value="all" />
        <button type="submit">Yes, rebuild all ${plural(n, "app", "apps")}</button>
        <a class="btn-link" href="/rebuild">Cancel</a>
      </form>
    </div>
  </details>`;
}

/** Both buttons with what they touch; goes at the top of the Rebuild page. */
export function renderRebuildActions(input: ActionsInput): string {
  return `<section class="rr-actions" aria-label="Start a rebuild">
    ${renderIssuesAction(input)}
    ${renderAllAction(input)}
  </section>`;
}
