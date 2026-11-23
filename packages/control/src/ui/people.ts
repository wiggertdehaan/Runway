/**
 * The Users page, as pure functions: one card per person with a neutral
 * role label, a 2FA label that is amber (not red) when it is off, the
 * apps they own, and the admin actions.
 *
 * Red means "something is wrong". A normal role ("member") is not an
 * error, so roles are plain tags; "2FA off" is a nudge, so it is amber.
 * The caller does the database work and the CSRF injection (layout()
 * adds the hidden field to every POST form).
 *
 * Nothing here changes who may do what: the same four forms post to the
 * same four routes, and those routes keep every server-side check.
 */

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export interface PersonRow {
  id: string;
  username: string;
  role: "admin" | "member";
  totpEnabled: boolean;
  createdAt: string;
  /** Names of the apps this person created. Admins see all apps anyway. */
  appNames: string[];
}

export interface PeopleContext {
  currentUserId: string;
  adminCount: number;
}

/** Neutral role tag. A member is a normal state, so no status colour. */
export function roleTag(role: "admin" | "member"): string {
  return `<span class="tag">${role === "admin" ? "Admin" : "Member"}</span>`;
}

/** 2FA on is green, 2FA off is amber: a recommendation, not an error. */
export function twoFaTag(enabled: boolean): string {
  return enabled
    ? '<span class="tag tag-ok">2FA on</span>'
    : '<span class="tag tag-warn" title="This person has not turned on two-factor authentication">2FA off</span>';
}

/** "all apps", "no apps yet", or up to three names plus a count. */
export function appsLabel(role: "admin" | "member", names: string[]): string {
  if (role === "admin") return "Manages all apps";
  if (names.length === 0) return "No apps yet";
  const shown = names.slice(0, 3).join(", ");
  const more = names.length - 3;
  return more > 0 ? `${shown} and ${more} more` : shown;
}

/** An admin cannot demote or delete themselves, nor the last admin. */
export function canChangeRole(row: Pick<PersonRow, "id" | "role">, ctx: PeopleContext): boolean {
  const isLastAdmin = row.role === "admin" && ctx.adminCount <= 1;
  return row.id !== ctx.currentUserId && !isLastAdmin;
}

function actions(row: PersonRow, ctx: PeopleContext): string {
  if (row.id === ctx.currentUserId) return '<span class="meta">This is you</span>';
  const id = encodeURIComponent(row.id);
  const roleForm = canChangeRole(row, ctx)
    ? `<form method="POST" action="/users/${id}/role" class="inline-form">
         <input type="hidden" name="role" value="${row.role === "admin" ? "member" : "admin"}" />
         <button type="submit" class="ghost">${row.role === "admin" ? "Make member" : "Make admin"}</button>
       </form>`
    : "";
  // The code field belongs to the person pressing the button: an admin
  // proves it is really them before another person's 2FA is removed.
  const resetForm = row.totpEnabled
    ? `<form method="POST" action="/users/${id}/2fa/reset" class="inline-form reset-2fa">
         <label class="meta" for="code-${escapeHtml(row.id)}">Reset 2FA: confirm with your own code</label>
         <span class="flex">
           <input type="text" id="code-${escapeHtml(row.id)}" name="code" inputmode="numeric" autocomplete="one-time-code" placeholder="Your own 6-digit code" required />
           <button type="submit" class="ghost">Reset 2FA</button>
         </span>
       </form>`
    : "";
  const deleteForm = `<form method="POST" action="/users/${id}/delete" class="inline-form" onsubmit="return confirm('Delete ${escapeHtml(row.username).replace(/'/g, "&#39;")}? Their sign-in stops working. Their apps stay, with no owner: only admins can manage them.')">
       <button class="danger" type="submit">Delete</button>
     </form>`;
  return `<div class="person-actions">${roleForm}${resetForm}${deleteForm}</div>`;
}

export function renderPersonCard(row: PersonRow, ctx: PeopleContext): string {
  return `
    <div class="card person">
      <div class="person-main">
        <div class="person-head">
          <h2>${escapeHtml(row.username)}</h2>
          ${roleTag(row.role)}
          ${twoFaTag(row.totpEnabled)}
        </div>
        <p class="meta">${escapeHtml(appsLabel(row.role, row.appNames))} &middot; added ${escapeHtml(row.createdAt)}</p>
      </div>
      ${actions(row, ctx)}
    </div>`;
}

/** The sentence under the page title: how many people, what roles can do. */
export function peopleSummary(rows: Array<Pick<PersonRow, "role">>): string {
  const n = rows.length;
  return `${n} ${n === 1 ? "person" : "people"}. Members can deploy and manage their own apps. Admins manage everything.`;
}

/** Error banner for the redirect codes the routes already use. */
export function peopleError(code: string | undefined): string {
  if (!code) return "";
  const msg =
    code === "last_admin"
      ? "Refused: that would leave zero admins. Make another user an admin first."
      : code === "needs_2fa"
        ? "Turn on 2FA on your own account before resetting it for others."
        : "That 2FA code did not work. Use the current code from your own authenticator app.";
  return `<div class="error">${escapeHtml(msg)}</div>`;
}
