/**
 * Token lists for the Account page and the administrator's overview (S18), as
 * pure functions. Nothing here can show a secret: the only things that reach
 * these functions are the summary rows (name, scope, last four characters,
 * dates), because the database layer never returns the hash.
 */

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export interface TokenRow {
  id: string;
  name: string;
  /** Last four characters of the token. */
  hint: string | null;
  scope: string | null;
  expires_at: string | null;
  last_used_at: string | null;
  revoked_at: string | null;
  /** Whose token, for the administrator's list; null on a person's own list. */
  username?: string | null;
  /** 1 when the upgrade, not the person, gave this token its expiry. */
  expiry_assigned?: number;
}

export type TokenState = "active" | "expired" | "revoked";

function parse(value: string): number {
  return Date.parse(value.replace(" ", "T") + "Z");
}

export function tokenState(t: Pick<TokenRow, "expires_at" | "revoked_at">, now = Date.now()): TokenState {
  if (t.revoked_at) return "revoked";
  if (t.expires_at && parse(t.expires_at) <= now) return "expired";
  return "active";
}

const STATE_TAG: Record<TokenState, string> = {
  active: '<span class="tag tag-ok">Active</span>',
  expired: '<span class="tag tag-warn">Expired</span>',
  revoked: '<span class="tag">Revoked</span>',
};

const SCOPE_TEXT: Record<string, string> = {
  read: "Read: look at your apps",
  deploy: "Deploy: read, plus change and deploy your apps",
  admin: "Admin: deploy, plus administrator actions",
};

export function scopeLabel(scope: string | null): string {
  if (!scope) return "Skills (read only)";
  return SCOPE_TEXT[scope] ?? scope;
}

function day(value: string | null): string {
  return value ? escapeHtml(value.slice(0, 10)) : "&mdash;";
}

/** "no expiry" is spelled out: an old developer token has none, and that is worth seeing. */
function expiryCell(t: TokenRow, state: TokenState): string {
  if (!t.expires_at) return '<span class="tag tag-warn" title="Issued before tokens expired. Revoke it and make a new one.">No expiry</span>';
  if (state === "expired") return `${day(t.expires_at)}`;
  const set =
    t.expiry_assigned === 1
      ? ' <span class="tag tag-warn" title="This token had no expiry. The upgrade gave it one. Make a new token before then and revoke this one.">set by upgrade</span>'
      : "";
  return `until ${day(t.expires_at)}${set}`;
}

/**
 * The banner on the Account page: developer tokens that had no expiry were
 * given one by the upgrade, and will stop working on that day. Empty when
 * none of the person's tokens are in that situation (or they have all
 * expired or been revoked already).
 */
export function legacyExpiryNotice(
  rows: Array<Pick<TokenRow, "expires_at" | "revoked_at" | "expiry_assigned">>,
  now = Date.now()
): string {
  const open = rows.filter(
    (t) => t.expiry_assigned === 1 && t.expires_at && tokenState(t, now) === "active"
  );
  if (open.length === 0) return "";
  const first = open
    .map((t) => t.expires_at as string)
    .sort()[0]!;
  const many = open.length > 1;
  return `<div class="card" id="legacy-expiry" style="border-color:var(--warn,#b45309)">
      <h2>${many ? `${open.length} of your tokens` : "One of your tokens"} will stop working on ${day(first)}</h2>
      <p class="meta" style="margin-top:0.5rem">
        ${many ? "These skill MCP tokens were" : "This skill MCP token was"} made before tokens expired, so
        ${many ? "they had" : "it had"} no end date. ${many ? "They now expire" : "It now expires"} on ${day(first)}
        (the date is in the list below). Until then ${many ? "they work" : "it works"} as before.
        To keep working, generate a new token under "Skill MCP tokens", put it in your Claude Code configuration, and
        revoke the old one.
      </p>
    </div>`;
}

/**
 * One table of tokens. `revokeAction` builds the form action for a row;
 * `showOwner` adds a column for the administrator's overview.
 */
export function renderTokenTable(
  rows: TokenRow[],
  opts: {
    revokeAction: (t: TokenRow) => string;
    showOwner?: boolean;
    empty: string;
    confirmText: string;
    now?: number;
  }
): string {
  if (rows.length === 0) return `<p class="meta" style="margin-top:0.75rem">${escapeHtml(opts.empty)}</p>`;
  const now = opts.now ?? Date.now();
  const body = rows
    .map((t) => {
      const state = tokenState(t, now);
      const owner = opts.showOwner
        ? `<td class="meta">${t.username ? escapeHtml(t.username) : "<em>deleted user</em>"}</td>`
        : "";
      const action =
        state === "revoked"
          ? ""
          : `<form method="POST" action="${escapeHtml(opts.revokeAction(t))}" style="margin:0" onsubmit="return confirm('${escapeHtml(opts.confirmText)}')">
               <button type="submit" class="danger" style="padding:0.25rem 0.6rem;font-size:0.75rem;width:auto">Revoke</button>
             </form>`;
      return `<tr>
          <td><strong>${escapeHtml(t.name)}</strong>${t.hint ? `<div class="meta"><code>…${escapeHtml(t.hint)}</code></div>` : ""}</td>
          ${owner}
          <td class="meta">${escapeHtml(scopeLabel(t.scope))}</td>
          <td>${STATE_TAG[state]} <span class="meta">${expiryCell(t, state)}</span></td>
          <td class="meta">${t.last_used_at ? day(t.last_used_at) : "never"}</td>
          <td style="text-align:right">${action}</td>
        </tr>`;
    })
    .join("");
  return `<div class="table-wrap"><table class="token-table">
      <thead><tr><th>Token</th>${opts.showOwner ? "<th>Person</th>" : ""}<th>Can do</th><th>Status</th><th>Last used</th><th></th></tr></thead>
      <tbody>${body}</tbody>
    </table></div>`;
}

/** The form that makes a user token: label, scope, lifetime. */
export function renderNewTokenForm(opts: { admin: boolean }): string {
  const scopes = [
    ["read", "Read: look at my apps"],
    ["deploy", "Deploy: read, plus change and deploy my apps"],
    ...(opts.admin ? [["admin", "Admin: deploy, plus administrator actions"]] : []),
  ] as Array<[string, string]>;
  return `<form method="POST" action="/account/access-tokens" style="margin-top:0.75rem">
      <div class="flex" style="gap:0.5rem;flex-wrap:wrap;align-items:center">
        <input type="text" name="name" placeholder="Label (e.g. laptop, CI)" aria-label="Token label" required maxlength="60" style="flex:1;min-width:10rem" />
        <select name="scope" aria-label="What the token may do" style="width:auto">
          ${scopes.map(([v, l], i) => `<option value="${v}"${i === 1 ? " selected" : ""}>${escapeHtml(l)}</option>`).join("")}
        </select>
        <select name="days" aria-label="How long it is valid" style="width:auto">
          <option value="30">30 days</option>
          <option value="90" selected>90 days</option>
          <option value="180">180 days</option>
          <option value="365">1 year</option>
        </select>
        <button type="submit" style="width:auto">Create token</button>
      </div>
    </form>`;
}
