/**
 * Rendering of the lifecycle controls: menu items, the buttons on the app page,
 * the confirmation dialog, the trash rows and the one-line notes. Pure: the
 * caller gathers the inputs. Everything that is app data is escaped.
 */
import { TRASH_DAYS } from "../deploy/lifecycle.js";

function esc(v: string): string {
  return v
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export type LifecycleAction = "stop" | "start" | "restart";

/** Which of Stop / Start / Restart apply to an app in this status. Quarantined and building apps get none. */
export function lifecycleActions(status: string, hasImage: boolean): LifecycleAction[] {
  if (!hasImage) return [];
  switch (status) {
    case "running":
      return ["restart", "stop"];
    case "failed":
      return ["restart", "stop"];
    case "stopped":
      return ["start"];
    default:
      return [];
  }
}

const LABEL: Record<LifecycleAction, string> = { stop: "Stop", start: "Start", restart: "Restart" };

/** Menu items for the ⋯ menu of one app row (forms, so they work without script). */
export function renderLifecycleMenuItems(appId: string, status: string, hasImage: boolean): string {
  const id = encodeURIComponent(appId);
  return lifecycleActions(status, hasImage)
    .map(
      (a) =>
        `<form method="POST" action="/apps/${id}/${a}" style="margin:0"><button type="submit" class="overflow-item">${LABEL[a]}</button></form>`
    )
    .join("");
}

/** The delete item: opens the confirmation dialog (script) and falls back to nothing without it. */
export function renderDeleteMenuItem(appId: string, expectedName: string): string {
  return `<button type="button" class="overflow-danger" data-del-open data-del-mode="trash" data-del-action="/apps/${encodeURIComponent(appId)}/delete" data-del-name="${esc(expectedName)}">Delete app&hellip;</button>`;
}

/** Buttons at the top of the app page. */
export function renderAppActions(appId: string, status: string, hasImage: boolean, expectedName: string): string {
  const id = encodeURIComponent(appId);
  const forms = lifecycleActions(status, hasImage)
    .map(
      (a) =>
        `<form method="POST" action="/apps/${id}/${a}" style="margin:0"><button type="submit" class="ghost app-act" data-act="${a}">${LABEL[a]}</button></form>`
    )
    .join("");
  return `<div class="app-actions">${forms}<button type="button" class="ghost app-act danger-ghost" data-del-open data-del-mode="trash" data-del-action="/apps/${id}/delete" data-del-name="${esc(expectedName)}">Delete&hellip;</button></div>`;
}

/** What a visitor of a stopped app and its owner should know, on the app page. */
export function renderStoppedBanner(app: { status: string; stopped_at: string | null }, fmt: (iso: string) => string): string {
  if (app.status !== "stopped") return "";
  const since = app.stopped_at ? ` since ${esc(fmt(app.stopped_at))}` : "";
  return `<div class="card stopped-banner"><strong>Stopped${since}.</strong> Visitors see a &ldquo;temporarily offline&rdquo; page. Data, settings and the address are kept. Use Start to bring it back (no rebuild).</div>`;
}

/**
 * The confirmation dialog (one per page, outside any htmx-swapped area). The
 * script in ui/client.ts fills it from the button's data-del-* attributes and
 * keeps the submit button disabled until the typed name matches exactly. The
 * server checks the same thing again.
 */
export function renderDeleteDialog(): string {
  return `<dialog id="del-dlg" class="del-dlg" aria-labelledby="del-title" data-trash-body="${esc(TRASH_BODY)}" data-purge-body="${esc(PURGE_BODY)}">
  <form method="POST" action="" id="del-form">
    <h2 id="del-title">Delete app</h2>
    <p id="del-body" class="meta"></p>
    <label class="meta" for="del-input">Type <strong id="del-expect"></strong> to confirm</label>
    <input type="text" id="del-input" name="confirm" autocomplete="off" autocapitalize="off" spellcheck="false" />
    <div class="del-buttons">
      <button type="button" class="ghost" id="del-cancel" style="width:auto">Cancel</button>
      <button type="submit" id="del-go" class="danger" style="width:auto" disabled>Delete</button>
    </div>
  </form>
</dialog>`;
}

export const TRASH_BODY =
  `The app is stopped and moved to the trash. Its address stays reserved and its data is kept for ${TRASH_DAYS} days; ` +
  `you can restore it in that time. After that everything is removed for good.`;
export const PURGE_BODY = "This removes the app, its data, volumes, stored source and certificates now. It cannot be undone.";

/** A row in the table for an app in the trash. */
export function renderTrashRow(
  app: { id: string; name: string | null; description: string | null; domain: string | null; custom_domain: string | null; deleted_at: string },
  opts: { admin: boolean; expectedName: string; now: number }
): string {
  const id = encodeURIComponent(app.id);
  const name = app.name ?? app.id;
  const left = daysLeft(app.deleted_at, opts.now);
  const domain = app.custom_domain ?? app.domain ?? "";
  const purge = opts.admin
    ? `<button type="button" class="danger" data-del-open data-del-mode="purge" data-del-action="/apps/${id}/purge" data-del-name="${esc(opts.expectedName)}" style="width:auto;padding:0.3rem 0.7rem;font-size:0.8rem">Delete now&hellip;</button>`
    : "";
  return `
    <tr class="app-row status-deleted" data-app-row data-name="${esc(name)}" data-domain="${esc(domain)}" data-status="deleted" data-attn="0" style="display:none">
      <td class="c-name"><span class="app-name">${esc(name)}</span><div class="meta">${esc(domain || "no address")}</div></td>
      <td class="c-status"><span class="meta">${left}</span></td>
      <td colspan="4" class="c-act">
        <form method="POST" action="/apps/${id}/restore" style="display:inline;margin:0 0.4rem 0 0"><button type="submit" class="ghost" style="width:auto;padding:0.3rem 0.7rem;font-size:0.8rem">Restore</button></form>
        ${purge}
      </td>
    </tr>`;
}

/** "5 days left" / "less than a day left" / "removed soon" for a trashed app. */
export function daysLeft(deletedAtIso: string, now: number): string {
  const at = Date.parse(deletedAtIso);
  if (!Number.isFinite(at)) return "in the trash";
  const ms = at + TRASH_DAYS * 86_400_000 - now;
  if (ms <= 0) return "removed soon";
  const days = Math.ceil(ms / 86_400_000);
  return days <= 1 ? "less than a day left" : `${days} days left`;
}

/** Fixed texts for the `?lc=` flash on the app page. Never reflects anything from the query. */
export const LIFECYCLE_NOTES: Record<string, { tone: "ok" | "err"; text: string }> = {
  stopped: { tone: "ok", text: "The app is stopped. Visitors see a temporarily-offline page; data and settings are kept." },
  "stopped-noop": { tone: "ok", text: "The app was already stopped." },
  started: { tone: "ok", text: "The app is running again." },
  "started-noop": { tone: "ok", text: "The app was already running." },
  restarted: { tone: "ok", text: "The app was restarted." },
  busy: { tone: "err", text: "A deploy, rebuild or another action is still running on this app. Wait for it to finish, then try again." },
  quarantined: { tone: "err", text: "This app is in quarantine. It comes back by itself once a rebuild or deploy fixes the vulnerability, or when an admin grants an exemption." },
  no_image: { tone: "err", text: "Deploy the app once first: there is no version to start." },
  unhealthy: { tone: "err", text: "The app did not become healthy and was stopped again. Check the logs." },
  error: { tone: "err", text: "That did not work. Check the control log." },
};

export function renderLifecycleNote(key: string | undefined): string {
  const n = key ? LIFECYCLE_NOTES[key] : undefined;
  if (!n) return "";
  return n.tone === "ok"
    ? `<div class="card" style="border-color:var(--ok);color:var(--ok)">${esc(n.text)}</div>`
    : `<div class="error">${esc(n.text)}</div>`;
}
