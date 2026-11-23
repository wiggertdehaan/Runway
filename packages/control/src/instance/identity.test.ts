import { describe, expect, it } from "vitest";
import { contrastRatio } from "../ui/contrast.js";
import { DARK, LIGHT } from "../ui/tokens.js";
import {
  NAME_MAX,
  SWATCHES,
  checkName,
  faviconSvg,
  faviconVersion,
  iconColorFor,
  markIsFaint,
  normalizeHex,
  pageTitle,
} from "./identity.js";

describe("normalizeHex", () => {
  it("takes #rgb and #rrggbb in any case and returns #rrggbb lowercase", () => {
    expect(normalizeHex("#2563EB")).toBe("#2563eb");
    expect(normalizeHex("  #1a8 ")).toBe("#11aa88");
    expect(normalizeHex("#ABC")).toBe("#aabbcc");
    expect(normalizeHex("#000000")).toBe("#000000");
  });

  it("refuses everything else", () => {
    for (const bad of ["", "2563eb", "#2563e", "#2563eb0", "#25 63eb", "#gggggg", "red", "rgb(1,2,3)", "#fff;x", "url(x)", "#12345g", null, undefined, 5, {}]) {
      expect(normalizeHex(bad as never), String(bad)).toBeNull();
    }
  });
});

describe("checkName", () => {
  it("accepts plain labels, trims and collapses whitespace, and treats empty as 'no name'", () => {
    expect(checkName("WSV")).toEqual({ ok: true, name: "WSV" });
    expect(checkName("  Roamler   prod ")).toEqual({ ok: true, name: "Roamler prod" });
    expect(checkName("R&D (test)")).toEqual({ ok: true, name: "R&D (test)" });
    expect(checkName("Wiggert's lab")).toEqual({ ok: true, name: "Wiggert's lab" });
    expect(checkName("Zürich-1")).toEqual({ ok: true, name: "Zürich-1" });
    expect(checkName("")).toEqual({ ok: true, name: "" });
    expect(checkName("   ")).toEqual({ ok: true, name: "" });
    expect(checkName(undefined)).toEqual({ ok: true, name: "" });
  });

  it("allows exactly NAME_MAX characters and refuses one more (counted in characters, not bytes)", () => {
    expect(checkName("a".repeat(NAME_MAX))).toMatchObject({ ok: true });
    expect(checkName("a".repeat(NAME_MAX + 1))).toEqual({ ok: false, reason: "too_long" });
    expect(checkName("é".repeat(NAME_MAX))).toMatchObject({ ok: true });
  });

  it("refuses markup, quotes and anything outside the character set", () => {
    for (const bad of ["<b>WSV</b>", "</script>", "a<b", "x>y", 'say "hi"', "back`tick", "a;b", "a/b", "a\\b", "{x}", "$(id)", "a=b", "-lead", " .dot", "Ignore: do it"]) {
      const r = checkName(bad);
      expect(r.ok, bad).toBe(false);
    }
  });

  it("removes control, bidi and zero-width characters instead of keeping them", () => {
    expect(checkName("WS\u0000V")).toEqual({ ok: true, name: "WS V" });
    expect(checkName("WSV\n")).toEqual({ ok: true, name: "WSV" });
    expect(checkName("a‮b")).toEqual({ ok: true, name: "a b" });
    expect(checkName("a​b")).toEqual({ ok: true, name: "a b" });
  });
});

describe("iconColorFor", () => {
  it("chooses the icon colour with the higher contrast", () => {
    expect(iconColorFor("#ffffff")).toBe("#0a0a0a");
    expect(iconColorFor("#000000")).toBe("#ffffff");
    expect(iconColorFor("#2563eb")).toBe("#ffffff");
    expect(iconColorFor("#d9500b")).toBe("#0a0a0a");
    expect(iconColorFor("#ffff00")).toBe("#0a0a0a");
  });

  it("sits on the boundary correctly: whichever side wins is the one with more contrast", () => {
    for (const hex of ["#777777", "#767676", "#787878", "#757575", "#808080", "#6f6f6f", "#949494"]) {
      const icon = iconColorFor(hex);
      const other = icon === "#ffffff" ? "#0a0a0a" : "#ffffff";
      expect(contrastRatio(hex, icon), hex).toBeGreaterThanOrEqual(contrastRatio(hex, other));
    }
  });
});

describe("the eight swatches", () => {
  it("are eight distinct valid colours", () => {
    expect(SWATCHES).toHaveLength(8);
    expect(new Set(SWATCHES.map((s) => s.hex)).size).toBe(8);
    expect(new Set(SWATCHES.map((s) => s.id)).size).toBe(8);
    for (const s of SWATCHES) expect(normalizeHex(s.hex)).toBe(s.hex);
  });

  it("stand out (3:1, non-text contrast) from the sidebar in BOTH themes", () => {
    for (const s of SWATCHES) {
      expect(contrastRatio(s.hex, LIGHT.side!), `${s.id} on light`).toBeGreaterThanOrEqual(3);
      expect(contrastRatio(s.hex, DARK.side!), `${s.id} on dark`).toBeGreaterThanOrEqual(3);
      expect(markIsFaint(s.hex), s.id).toBe(false);
    }
  });

  it("carry an icon that is readable on them (3:1 for graphics, 4:1 here), whichever colour is picked", () => {
    for (const s of SWATCHES) {
      const icon = iconColorFor(s.hex);
      expect(contrastRatio(s.hex, icon), s.id).toBeGreaterThanOrEqual(4);
    }
  });

  it("use a white icon on the dark ones and a near-black one on orange", () => {
    const icon = (id: string) => iconColorFor(SWATCHES.find((s) => s.id === id)!.hex);
    expect(icon("blue")).toBe("#ffffff");
    expect(icon("green")).toBe("#ffffff");
    expect(icon("orange")).toBe("#0a0a0a");
  });
});

describe("markIsFaint (a hint for custom colours)", () => {
  it("flags near-white and near-black, not mid-tones", () => {
    expect(markIsFaint("#fafafa")).toBe(true);
    expect(markIsFaint("#0d0d0d")).toBe(true);
    expect(markIsFaint("#ffffff")).toBe(true);
    expect(markIsFaint("#808080")).toBe(false);
  });
});

describe("pageTitle", () => {
  it("adds the instance name after Runway, and nothing when there is none", () => {
    expect(pageTitle("Overview", "WSV")).toBe("Overview · Runway WSV");
    expect(pageTitle("Overview", null)).toBe("Overview · Runway");
    expect(pageTitle("Settings", "Roamler (prod)")).toBe("Settings · Runway Roamler (prod)");
  });
});

describe("faviconSvg", () => {
  it("is the standard icon without a colour", () => {
    const svg = faviconSvg(null);
    expect(svg).toContain('fill="#0a0a0a"');
    expect(svg).toContain('stroke="#ffffff"');
  });

  it("uses the colour and a readable icon colour", () => {
    expect(faviconSvg("#2563eb")).toContain('fill="#2563eb"');
    expect(faviconSvg("#2563eb")).toContain('stroke="#ffffff"');
    expect(faviconSvg("#d9500b")).toContain('stroke="#0a0a0a"');
  });

  it("is well-formed: one root element, no script, no event handlers, no external references", () => {
    const svg = faviconSvg("#16803c");
    expect(svg.startsWith("<svg ")).toBe(true);
    expect(svg.endsWith("</svg>")).toBe(true);
    expect(svg).not.toMatch(/<script|onload|onerror|href=|xlink|<foreignObject|<image|url\(/i);
    expect((svg.match(/<svg/g) ?? []).length).toBe(1);
  });

  it("the cache-busting version changes with the colour", () => {
    expect(faviconVersion("#2563eb")).toBe("2563eb");
    expect(faviconVersion(null)).toBe("0");
    expect(faviconVersion("#2563eb")).not.toBe(faviconVersion("#16803c"));
  });
});
