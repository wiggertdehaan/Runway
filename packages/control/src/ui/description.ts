/**
 * Rendering of an app description. Always escaped text, never markdown or HTML:
 * the text can come from a README the deployer uploaded (untrusted).
 */
import { MAX_DESCRIPTION } from "../util/description.js";

function esc(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** One line under the app name in the list. The full text is the tooltip. Empty: nothing at all. */
export function renderDescriptionLine(description: string | null | undefined): string {
  const text = (description ?? "").trim();
  if (!text) return "";
  return `<div class="app-desc-line" title="${esc(text)}">${esc(text)}</div>`;
}

/**
 * Under the name on the app page: the text and, for somebody who may change it,
 * an Edit disclosure with a plain form (no script needed). Without a description
 * and without edit rights there is nothing to show.
 */
export function renderDescriptionBlock(
  appId: string,
  description: string | null | undefined,
  canEdit: boolean
): string {
  const text = (description ?? "").trim();
  if (!text && !canEdit) return "";
  const form = canEdit
    ? `<details class="app-desc-edit">
        <summary>${text ? "Edit description" : "Add a description"}</summary>
        <form method="POST" action="/apps/${encodeURIComponent(appId)}/description">
          <label class="meta" for="app-desc-input">What is it, who is it for, what is it used for? Plain text, max ${MAX_DESCRIPTION} characters.</label>
          <textarea id="app-desc-input" name="description" rows="3" maxlength="${MAX_DESCRIPTION}">${esc(text)}</textarea>
          <button type="submit" style="width:auto">Save</button>
        </form>
      </details>`
    : "";
  return `<div class="app-desc">${text ? `<p class="app-desc-text">${esc(text)}</p>` : ""}${form}</div>`;
}
