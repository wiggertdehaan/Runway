import { describe, expect, it } from "vitest";
import { contrastRatio } from "./contrast.js";
import { AA_PAIRS, DARK, LIGHT, declarations, themeCss } from "./tokens.js";

describe("contrastRatio", () => {
  it("matches the WCAG reference values", () => {
    expect(contrastRatio("#000000", "#ffffff")).toBeCloseTo(21, 5);
    expect(contrastRatio("#ffffff", "#ffffff")).toBeCloseTo(1, 5);
    expect(contrastRatio("#767676", "#ffffff")).toBeGreaterThan(4.5);
  });
  it("is symmetric", () => {
    expect(contrastRatio("#0a0a0a", "#fafafa")).toBe(contrastRatio("#fafafa", "#0a0a0a"));
  });
  it("rejects non-hex input", () => {
    expect(() => contrastRatio("red", "#fff")).toThrow();
  });
});

describe("design tokens", () => {
  it("defines the same token names in both themes", () => {
    expect(Object.keys(DARK).sort()).toEqual(Object.keys(LIGHT).sort());
  });

  for (const [name, theme] of [["light", LIGHT], ["dark", DARK]] as const) {
    for (const [fg, bg] of AA_PAIRS) {
      it(`${name}: ${fg} on ${bg} reaches AA (4.5:1)`, () => {
        expect(contrastRatio(theme[fg], theme[bg])).toBeGreaterThanOrEqual(4.5);
      });
    }
  }

  it("emits light by default, dark for the OS preference and for the toggle", () => {
    const css = themeCss();
    expect(css.startsWith(":root{")).toBe(true);
    expect(css).toContain("@media (prefers-color-scheme:dark){:root:not([data-theme=light])");
    expect(css).toContain(':root[data-theme=dark]{');
    expect(declarations({ a: "#fff" })).toBe("--a:#fff;");
  });
});

describe("app shell", () => {
  const rule = (css: string, selector: string, from = 0): string => {
    const i = css.indexOf(selector + "{", from);
    expect(i).toBeGreaterThanOrEqual(0);
    return css.slice(i, css.indexOf("}", i));
  };

  it("paints the sidebar column on the grid itself, so it runs the full page height", async () => {
    const { APP_CSS } = await import("./styles.js");
    const shell = rule(APP_CSS, ".shell");
    // The sticky .side is only as tall as the viewport; the colour of its column
    // must not depend on that (full-page captures, overscroll, zoomed-out pages).
    expect(shell).toContain("linear-gradient(to right,var(--side)");
    expect(shell).toContain("var(--sw)");
    expect(shell).toContain("min-height:100dvh");
    expect(rule(APP_CSS, ".side")).toContain("position:sticky");
  });

  it("drops the column background in the top-bar layout below 900px", async () => {
    const { APP_CSS } = await import("./styles.js");
    const mobile = APP_CSS.slice(APP_CSS.indexOf("@media (max-width:899px)"));
    expect(rule(mobile, "  .shell")).toContain("background:none");
  });
});
