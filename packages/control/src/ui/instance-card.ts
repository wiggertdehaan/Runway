/**
 * The "Instance identity" card on /settings and the logo mark that uses the
 * colour. Pure string builders: everything that comes from a stored value is
 * validated (identity.ts) and still escaped here.
 */
import { SWATCHES, iconColorFor, markIsFaint, type InstanceIdentity } from "../instance/identity.js";

function esc(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

const PLANE =
  '<svg class="ic" width="__S__" height="__S__" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 12 21 4l-5 16-4-6.5z"/><path d="m12 13.5 9-9.5"/></svg>';

/** The logo square: the standard look when there is no colour, else the colour with a readable icon. */
export function renderMark(color: string | null, opts: { large?: boolean } = {}): string {
  const size = opts.large ? 20 : 14;
  const style = color ? ` style="background:${esc(color)};color:${esc(iconColorFor(color))}"` : "";
  return `<span class="mark${opts.large ? " mark-lg" : ""}"${style}>${PLANE.replace(/__S__/g, String(size))}</span>`;
}

export type IdentityError = "color" | "name_long" | "name_chars" | null;

export function identityErrorFromQuery(q: string | undefined): IdentityError {
  return q === "instance_color" ? "color" : q === "instance_name_long" ? "name_long" : q === "instance_name_chars" ? "name_chars" : null;
}

const ERROR_TEXT: Record<Exclude<IdentityError, null>, string> = {
  color: "That is not a colour. Use a hex value like #1a73e8 or #18e.",
  name_long: "The name can be at most 24 characters.",
  name_chars: "The name may only use letters, numbers, spaces and . _ & + ' ( ) -",
};

export function renderInstanceCard(identity: InstanceIdentity, error: IdentityError = null): string {
  const current = identity.color;
  const swatch = SWATCHES.find((s) => s.hex === current);
  const custom = current && !swatch ? current : "";
  const swatchHtml = SWATCHES.map(
    (s) =>
      `<label class="swatch" title="${esc(s.label)}"><input type="radio" name="color_choice" value="${s.hex}"${current === s.hex ? " checked" : ""} /><span class="swatch-dot" style="background:${s.hex}"></span><span class="sr">${esc(s.label)}</span></label>`
  ).join("");
  const faint = custom && markIsFaint(custom) ? '<p class="hint" role="note">This colour is close to the sidebar background in one theme, so the logo square can be hard to see. A mid-tone colour reads best in both.</p>' : "";
  return `
          <div class="card" id="identity">
            <h2>Instance identity</h2>
            <p class="hint" style="margin:0.5rem 0 1rem">
              Tells your Runway servers apart. The colour fills the logo square and the browser-tab icon; the name sits next to &ldquo;Runway&rdquo;, in the page title and on the login page. Leave both empty for the standard look.
            </p>
            ${error ? `<div class="error">${esc(ERROR_TEXT[error])}</div>` : ""}
            <form method="POST" action="/settings/instance-identity">
              <fieldset class="id-fields">
                <legend class="id-label">Colour</legend>
                <div class="swatches">
                  ${swatchHtml}
                </div>
                <div class="id-row">
                  <label class="id-opt"><input type="radio" name="color_choice" value="custom" id="inst-custom"${custom ? " checked" : ""} /> Custom</label>
                  <input type="text" name="color_custom" value="${esc(custom)}" placeholder="#1a73e8" maxlength="7" autocomplete="off" spellcheck="false" aria-label="Custom colour as hex" data-pick-custom style="width:9rem" />
                  <label class="id-opt"><input type="radio" name="color_choice" value="none"${current ? "" : " checked"} /> Standard</label>
                </div>
                ${faint}
              </fieldset>
              <div class="id-row" style="margin-top:1rem">
                <label class="id-label" for="instance_name">Name</label>
                <input type="text" id="instance_name" name="instance_name" value="${esc(identity.name ?? "")}" placeholder="e.g. WSV" maxlength="24" autocomplete="off" style="width:14rem" />
                <span class="hint" style="margin:0">Optional, up to 24 characters.</span>
              </div>
              <div class="id-preview" aria-label="Preview">
                ${renderMark(current, { large: true })}<span class="id-preview-text">Runway${identity.name ? `<small class="inst-name">${esc(identity.name)}</small>` : ""}</span>
              </div>
              <div class="flex">
                <button type="submit">Save</button>
                <button type="submit" name="action" value="reset" class="ghost">Reset to standard</button>
              </div>
            </form>
          </div>`;
}
