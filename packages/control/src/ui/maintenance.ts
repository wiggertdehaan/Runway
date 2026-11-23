/**
 * "Automatic maintenance": the per-app switches that decide what Runway
 * does on its own at rebuild time. Pure rendering, no database: the caller
 * passes the app row and whether the viewer is an admin.
 *
 * Each switch is a real checkbox (role="switch") inside its own form that
 * posts to the same endpoint the old buttons used. With JavaScript, flipping
 * the switch submits the form; without it, a visible Apply button does.
 * Only admins may change a switch (the routes enforce that); everyone else
 * sees the state, read-only.
 */

export interface MaintenanceApp {
  id: string;
  auto_rebuild: number;
  auto_patch_base: number;
  auto_minor_base: number;
  auto_update_deps: number;
  auto_update_deps_major: number;
}

export interface MaintenanceSwitch {
  /** Last path segment of POST /apps/:id/<action>. */
  action: "auto-rebuild" | "auto-patch" | "auto-minor" | "auto-deps" | "auto-deps-major";
  label: string;
  help: string;
  on: boolean;
  /** Cannot be turned on yet; the reason is shown under the help text. */
  blocked: string | null;
}

function esc(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** The five switches, in the order they are shown, with their current state. */
export function maintenanceSwitches(app: MaintenanceApp): MaintenanceSwitch[] {
  const depsOn = !!app.auto_update_deps;
  const majorOn = !!app.auto_update_deps_major;
  return [
    {
      action: "auto-rebuild",
      label: "Weekly rebuild",
      help: "On the weekly schedule (set under Rebuild), rebuilds this app when it has an actively exploited or fixable critical finding.",
      on: !!app.auto_rebuild,
      blocked: null,
    },
    {
      action: "auto-patch",
      label: "Patch the base image",
      help: "On rebuild, raises an exact patch pin in FROM (nginx:1.30.6-alpine to the newest 1.30.x-alpine) in a build-time copy. Your source is never changed.",
      on: !!app.auto_patch_base,
      blocked: null,
    },
    {
      action: "auto-minor",
      label: "Minor escalation",
      help: "Only if patching does not fix a critical finding: tries the lowest newer minor line of the same major and variant (nginx 1.30 to 1.31). Majors are never automatic.",
      on: !!app.auto_minor_base,
      blocked: null,
    },
    {
      action: "auto-deps",
      label: "Update vulnerable dependencies",
      help: "On rebuild, raises your own packages (requirements.txt, package.json) that have a known vulnerability with a fix, within the installed major version. An update only goes live if the scan improves and the app still starts; otherwise the previous version stays. Changed files are saved as a new source snapshot; your upload stays available under Deploys.",
      on: depsOn,
      blocked: null,
    },
    {
      action: "auto-deps-major",
      label: "Allow major updates",
      help: "Off by default. A health check only proves the app starts, not that a major update leaves it working. While off, a rebuild reports the major update that is available instead of building it.",
      on: majorOn,
      // Turning it off must always work; turning it on needs dependency updates.
      blocked: !depsOn && !majorOn ? "Turn on “Update vulnerable dependencies” first." : null,
    },
  ];
}

/** "3 of 5 on". */
export function maintenanceSummary(switches: MaintenanceSwitch[]): string {
  const on = switches.filter((s) => s.on).length;
  return `${on} of ${switches.length} on`;
}

function renderRow(appId: string, s: MaintenanceSwitch, admin: boolean): string {
  const id = `sw-${s.action}`;
  const locked = !admin || s.blocked !== null;
  const stateText = s.on ? "On" : "Off";
  const note = s.blocked ? `<small class="swn">${esc(s.blocked)}</small>` : "";
  // The value the form posts is the state AFTER the click.
  const next = s.on ? "0" : "1";
  const control = admin
    ? `<form method="POST" action="/apps/${encodeURIComponent(appId)}/${s.action}" class="swf">
        <input type="hidden" name="enabled" value="${next}" />
        <span class="sws" aria-hidden="true">${stateText}</span>
        <label class="sw"><input type="checkbox" role="switch" id="${id}" aria-describedby="${id}-h" ${s.on ? "checked" : ""} ${s.blocked ? "disabled" : ""} data-autosubmit /><span class="trk"></span></label>
        <noscript><button type="submit" class="ghost swb">Apply</button></noscript>
      </form>`
    : `<div class="swf"><span class="sws">${stateText}</span><label class="sw"><input type="checkbox" role="switch" id="${id}" aria-describedby="${id}-h" ${s.on ? "checked" : ""} disabled /><span class="trk"></span></label></div>`;
  return `<div class="swr${locked ? " locked" : ""}">
      <div><label for="${id}"><b>${esc(s.label)}</b></label><small id="${id}-h">${esc(s.help)}</small>${note}</div>
      <div class="swc">${control}</div>
    </div>`;
}

/** The whole card. Admins get live switches, everyone else the read-only state. */
export function renderMaintenance(app: MaintenanceApp, admin: boolean): string {
  const switches = maintenanceSwitches(app);
  const tag = admin
    ? `<span class="tag">Admin setting</span>`
    : `<span class="tag">Set by an administrator</span>`;
  const foot = admin
    ? ""
    : `<p class="meta swfoot">Ask an administrator if you want a change for this app.</p>`;
  return `<div class="maint" id="maintenance">
    <div class="maint-h">
      <div><h3>Automatic maintenance</h3><p class="meta">What Runway does on its own when this app is rebuilt. ${esc(maintenanceSummary(switches))}. Every change is written to the audit log.</p></div>
      ${tag}
    </div>
    ${switches.map((s) => renderRow(app.id, s, admin)).join("\n")}
    ${foot}
  </div>`;
}
