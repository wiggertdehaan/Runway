/**
 * "Owner" card on an app's Config tab (admins only): who owns the app, and a
 * form to give it to someone else or to nobody. Rights follow the owner's
 * user id (see db/apps.ts), so an ownerless app is admin-only. Pure rendering:
 * the route enforces admin and CSRF.
 */
const esc = (s: string): string =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

export interface OwnerCandidate {
  id: string;
  username: string;
  role: string;
}

export function renderOwnerCard(
  app: { id: string; owner_user_id: string | null },
  ownerName: string | null,
  candidates: OwnerCandidate[]
): string {
  const ownerless = app.owner_user_id === null || ownerName === null;
  const options = [
    `<option value=""${ownerless ? " selected" : ""}>No owner (admin only)</option>`,
    ...candidates.map(
      (u) =>
        `<option value="${esc(u.id)}"${u.id === app.owner_user_id ? " selected" : ""}>${esc(u.username)}${
          u.role === "admin" ? " (admin)" : ""
        }</option>`
    ),
  ].join("");
  const state = ownerless
    ? `<p class="meta" style="margin:0 0 0.75rem"><span class="badge badge-quarantined">no owner</span> Only administrators can see and manage this app. Give it to someone to let them rebuild, rescan and see it.</p>`
    : `<p class="meta" style="margin:0 0 0.75rem">Owned by <b>${esc(ownerName!)}</b>. The owner can see this app, rebuild it and rescan it.</p>`;
  return `<div class="card" id="owner">
      <h2>Owner</h2>
      ${state}
      <form method="POST" action="/apps/${encodeURIComponent(app.id)}/owner">
        <div class="flex" style="flex-wrap:wrap;gap:0.75rem;align-items:center">
          <label for="owner-user">Owner</label>
          <select id="owner-user" name="owner">${options}</select>
          <button type="submit">Save</button>
        </div>
      </form>
      <p class="hint" style="margin:0.75rem 0 0">Changing the owner takes effect at once. Every change is written to the audit log.</p>
    </div>`;
}
