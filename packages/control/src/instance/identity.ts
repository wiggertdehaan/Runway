/**
 * Instance identity: a colour and an optional short name that tell several
 * Runway servers apart (logo square, favicon, page title, login page).
 *
 * It is display only. Nothing here decides who may do what, and the MCP
 * client shows it but never routes on it. Values live in the settings table
 * (no migration) and are validated both when they are written and when they
 * are read, so a hand-edited row can never put markup into a page.
 */
import { contrastRatio } from "../ui/contrast.js";
import { LIGHT, DARK } from "../ui/tokens.js";
import { getSetting } from "../db/settings.js";

export interface Swatch {
  id: string;
  label: string;
  hex: string;
}

/**
 * Mid-tone colours: each stays at least 3:1 against both the light and the
 * dark sidebar (non-text contrast), so the logo square is visible in either
 * theme. identity.test.ts measures that, so a change here cannot slip below it.
 */
export const SWATCHES: readonly Swatch[] = [
  { id: "blue", label: "Blue", hex: "#2563eb" },
  { id: "green", label: "Green", hex: "#16803c" },
  { id: "orange", label: "Orange", hex: "#d9500b" },
  { id: "purple", label: "Purple", hex: "#7c3aed" },
  { id: "red", label: "Red", hex: "#d12a2a" },
  { id: "teal", label: "Teal", hex: "#0f7a74" },
  { id: "pink", label: "Pink", hex: "#d62a7c" },
  { id: "amber", label: "Amber", hex: "#a8620a" },
];

export const NAME_MAX = 24;
/**
 * A name is a short label, not free text: letters, digits, space and a few
 * marks. Anything else (angle brackets, quotes, backticks, newlines) is
 * refused, which keeps both a page and an agent reading it safe.
 */
const NAME_RE = /^[\p{L}\p{N}][\p{L}\p{N} ._&+'()-]*$/u;

/** `#abc` or `#aabbcc` (any case) to `#aabbcc` lowercase; anything else is null. */
export function normalizeHex(input: unknown): string | null {
  if (typeof input !== "string") return null;
  const s = input.trim().toLowerCase();
  const m = /^#([0-9a-f]{3})$/.exec(s);
  if (m) return `#${[...m[1]!].map((c) => c + c).join("")}`;
  return /^#[0-9a-f]{6}$/.test(s) ? s : null;
}

export type NameCheck = { ok: true; name: string } | { ok: false; reason: "too_long" | "bad_chars" };

/** Control characters out, whitespace collapsed; then length and character set are checked. "" is valid (no name). */
export function checkName(input: unknown): NameCheck {
  const raw = typeof input === "string" ? input : "";
  const cleaned = raw
    .replace(/[\u0000-\u001f\u007f-\u009f­​-‏‪-‮⁠-⁤⁦-⁩﻿]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (cleaned === "") return { ok: true, name: "" };
  if (Array.from(cleaned).length > NAME_MAX) return { ok: false, reason: "too_long" };
  if (!NAME_RE.test(cleaned)) return { ok: false, reason: "bad_chars" };
  return { ok: true, name: cleaned };
}

const ICON_LIGHT = "#ffffff";
const ICON_DARK = "#0a0a0a";

/** The icon colour (white or near-black) that reads best on this background. */
export function iconColorFor(bg: string): string {
  return contrastRatio(bg, ICON_LIGHT) >= contrastRatio(bg, ICON_DARK) ? ICON_LIGHT : ICON_DARK;
}

/**
 * Does the logo square stand out from both sidebars? Swatches always do;
 * a custom colour may not (near white or near black). Used for a hint, not a ban.
 */
export function markContrast(bg: string): { light: number; dark: number } {
  return { light: contrastRatio(bg, LIGHT.side!), dark: contrastRatio(bg, DARK.side!) };
}

export function markIsFaint(bg: string): boolean {
  const c = markContrast(bg);
  return c.light < 3 || c.dark < 3;
}

export interface InstanceIdentity {
  /** `#rrggbb` or null (= the standard look). */
  color: string | null;
  /** A validated label or null. */
  name: string | null;
}

/** The stored identity, re-validated: a bad stored value reads as "not set". */
export function getInstanceIdentity(): InstanceIdentity {
  const color = normalizeHex(getSetting("instance_color"));
  const checked = checkName(getSetting("instance_name"));
  const name = checked.ok && checked.name ? checked.name : null;
  return { color, name };
}

/** The page title: "Overview · Runway WSV". */
export function pageTitle(title: string, name: string | null): string {
  return `${title} · Runway${name ? ` ${name}` : ""}`;
}

/** The favicon: the Runway paper plane on a rounded square, in the instance colour. */
export function faviconSvg(color: string | null): string {
  const bg = color ?? "#0a0a0a";
  const fg = iconColorFor(bg);
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32">` +
    `<rect width="32" height="32" rx="7" fill="${bg}"/>` +
    `<path d="M7 16 25 8l-5 17-4-7z" fill="none" stroke="${fg}" stroke-width="2" stroke-linejoin="round"/>` +
    `</svg>`
  );
}

/** A short code that changes with the colour, so a browser fetches the favicon again after a change. */
export function faviconVersion(color: string | null): string {
  return color ? color.slice(1) : "0";
}
