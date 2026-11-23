/**
 * Design tokens for the dashboard (redesign v2, variant A: monochrome,
 * status colour only for status). One source of truth: layout() emits
 * these as CSS custom properties, and tokens.test.ts measures WCAG
 * contrast on the pairs below so a palette tweak can't silently drop
 * under AA.
 *
 * There is deliberately no brand colour yet: the accent is `inv`
 * (black on light, near-white on dark), used for primary buttons,
 * selected chips and the active tab.
 */
export type ThemeTokens = Record<string, string>;

export const LIGHT: ThemeTokens = {
  bg: "#ffffff",
  bg2: "#fafafa",
  side: "#fafafa",
  line: "#eaeaea",
  line2: "#d4d4d4",
  ctl: "#8a8a8a",
  tx: "#0a0a0a",
  mu: "#595959",
  inv: "#0a0a0a",
  invtx: "#ffffff",
  ring: "#0a0a0a",
  ok: "#0b7a3b",
  okbg: "#e6f4ea",
  warn: "#8a5300",
  warnbg: "#fff4e0",
  err: "#b42318",
  errbg: "#fdecec",
  gray: "#8a8a8a",
  sh: "0 8px 24px rgba(0,0,0,.14)",
};

export const DARK: ThemeTokens = {
  bg: "#0a0a0a",
  bg2: "#111111",
  side: "#0d0d0d",
  line: "#262626",
  line2: "#3a3a3a",
  ctl: "#737373",
  tx: "#ededed",
  mu: "#a3a3a3",
  inv: "#ededed",
  invtx: "#0a0a0a",
  ring: "#ededed",
  ok: "#4ade80",
  okbg: "#0f2a18",
  warn: "#fbbf24",
  warnbg: "#2a2008",
  err: "#ff8a8a",
  errbg: "#2e1112",
  gray: "#737373",
  sh: "0 8px 24px rgba(0,0,0,.6)",
};

/** Foreground/background pairs that must reach WCAG AA (4.5:1). */
export const AA_PAIRS: Array<[fg: string, bg: string]> = [
  ["tx", "bg"],
  ["tx", "bg2"],
  ["tx", "side"],
  ["mu", "bg"],
  ["mu", "bg2"],
  ["mu", "side"],
  ["invtx", "inv"],
  ["ok", "bg"],
  ["ok", "okbg"],
  ["warn", "bg"],
  ["warn", "warnbg"],
  ["err", "bg"],
  ["err", "errbg"],
];

/** `--name:value;` declarations for one theme. */
export function declarations(t: ThemeTokens): string {
  return Object.entries(t)
    .map(([k, v]) => `--${k}:${v};`)
    .join("");
}

/**
 * Theme CSS: light by default, dark when the OS asks for it, and an
 * explicit `data-theme` (set by the toggle) wins over the OS either way.
 */
export function themeCss(): string {
  return (
    `:root{${declarations(LIGHT)}color-scheme:light}` +
    `@media (prefers-color-scheme:dark){:root:not([data-theme=light]){${declarations(DARK)}color-scheme:dark}}` +
    `:root[data-theme=dark]{${declarations(DARK)}color-scheme:dark}`
  );
}
