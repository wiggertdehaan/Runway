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
