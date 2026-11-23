/**
 * "Container hardening": which privilege profile an app's container runs
 * with (see deploy/hardening.ts). Pure rendering: the caller passes the app
 * row and whether the viewer is an admin. Only admins may change it (the
 * route enforces that); an owner sees what applies and whom to ask.
 */
import { resolveHardening, type HardeningMode, type HardeningSource } from "../deploy/hardening.js";

export interface HardeningApp {
  id: string;
  hardening_profile: string | null;
  readonly_rootfs: number;
}

const esc = (s: string): string =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** One line per profile, in plain words. */
export function describeProfile(mode: HardeningMode): string {
  switch (mode) {
    case "standard":
      return "Linux capabilities are reduced to the few an ordinary image needs, processes cannot gain extra privileges, at most 512 processes, no swap, and logs are rotated.";
    case "strict":
      return "Like standard, but with no extra capabilities at all. Fits apps that already run as a non-root user.";
    case "relaxed":
      return "Docker's own defaults: no capability reduction, no process limit. Logs are still rotated. Use only for an app that does not run otherwise.";
  }
}

export function describeSource(source: HardeningSource): string {
  switch (source) {
    case "emergency-brake":
      return "RUNWAY_HARDENING=relaxed is set on this server and overrides everything";
    case "app":
      return "set for this app by an administrator";
    case "instance":
      return "this server's default (RUNWAY_HARDENING)";
    case "default":
      return "the default";
  }
}

const PROFILE_OPTIONS: Array<{ value: string; label: string }> = [
  { value: "", label: "Server default" },
  { value: "standard", label: "Standard" },
  { value: "strict", label: "Strict" },
  { value: "relaxed", label: "Relaxed (escape hatch)" },
];

/** The whole card. Admins get the form, everyone else the read-only state. */
export function renderHardening(
  app: HardeningApp,
  admin: boolean,
  env: Record<string, string | undefined> = process.env
): string {
  const eff = resolveHardening(app.hardening_profile, env);
  const ro = app.readonly_rootfs === 1 && eff.mode !== "relaxed";
  const state = `<p class="meta" style="margin:0 0 0.75rem">Running profile: <b>${esc(eff.mode)}</b> (${esc(describeSource(eff.source))}).${
    ro ? " Root filesystem is read-only; /tmp stays writable." : ""
  }</p>
    <p class="hint" style="margin:0 0 1rem">${esc(describeProfile(eff.mode))}</p>`;
  const when = `<p class="hint" style="margin:0.75rem 0 0">A change applies the next time the container is created (next deploy or rebuild). A running container keeps the settings it started with.</p>`;

  if (!admin) {
    return `<div class="card" id="hardening">
      <h2>Container hardening</h2>
      ${state}
      <p class="meta">Set by an administrator. Ask one if your app needs a different profile, for example when it logs "Operation not permitted" or "Resource temporarily unavailable" at startup.</p>
    </div>`;
  }

  const current = app.hardening_profile ?? "";
  const options = PROFILE_OPTIONS.map(
    (o) => `<option value="${esc(o.value)}"${o.value === current ? " selected" : ""}>${esc(o.label)}</option>`
  ).join("");
  return `<div class="card" id="hardening">
      <h2>Container hardening</h2>
      ${state}
      <form method="POST" action="/apps/${encodeURIComponent(app.id)}/hardening">
        <div class="flex" style="flex-wrap:wrap;gap:0.75rem;align-items:center">
          <label for="hardening-profile">Profile</label>
          <select id="hardening-profile" name="profile">${options}</select>
          <label style="display:flex;gap:0.4rem;align-items:center"><input type="checkbox" name="readonly" value="1"${
            app.readonly_rootfs === 1 ? " checked" : ""
          } /> Read-only root filesystem</label>
          <button type="submit">Save</button>
        </div>
      </form>
      <p class="hint" style="margin:0.75rem 0 0">Read-only root filesystem makes everything except /tmp and the app's volumes read-only; it breaks apps that write elsewhere, so it is off by default. Every change is written to the audit log.</p>
      ${when}
    </div>`;
}
