import vm from "node:vm";
import { describe, expect, it } from "vitest";
import {
  PALETTE_JS,
  buildPaletteItems,
  paletteJson,
  renderPalette,
  type PaletteItem,
} from "./palette.js";

const apps = [
  { id: "a1", name: "weekplanner" },
  { id: "b2", name: "ledenlijst" },
  { id: "c3", name: null },
];
const titles = (items: PaletteItem[]) => items.map((i) => i.t);

describe("buildPaletteItems", () => {
  it("gives an owner no admin-only pages", () => {
    const t = titles(buildPaletteItems({ admin: false, apps }));
    expect(t).toEqual(expect.arrayContaining(["Apps", "Security", "Account"]));
    for (const adminOnly of ["Rebuild", "Audit", "Health", "Users", "Skills", "Settings"]) {
      expect(t).not.toContain(adminOnly);
    }
  });

  it("gives an admin every page", () => {
    const t = titles(buildPaletteItems({ admin: true, apps }));
    for (const page of ["Rebuild", "Audit", "Health", "Users", "Skills", "Settings"]) {
      expect(t).toContain(page);
    }
  });

  it("lists only apps it was given, and skips apps that were never deployed", () => {
    const items = buildPaletteItems({ admin: false, apps: [apps[0], apps[2]] });
    expect(items.filter((i) => i.g === "Apps").map((i) => i.t)).toEqual(["weekplanner"]);
  });

  it("links apps by encoded id and keeps every entry navigation or the theme action", () => {
    const items = buildPaletteItems({ admin: true, apps: [{ id: "x/../y", name: "odd" }] });
    expect(items.find((i) => i.t === "odd")?.h).toBe("/apps/x%2F..%2Fy");
    for (const i of items) {
      expect(Boolean(i.h) !== Boolean(i.a)).toBe(true);
      if (i.h) expect(i.h.startsWith("/")).toBe(true);
      if (i.a) expect(i.a).toBe("theme");
    }
  });
});

describe("paletteJson / renderPalette", () => {
  it("cannot break out of the script element", () => {
    const evil = [{ g: "Apps", t: "</script><img src=x onerror=alert(1)>&\u2028", h: "/" }] as PaletteItem[];
    const json = paletteJson(evil);
    expect(json).not.toMatch(/[<>&\u2028\u2029]/);
    expect(JSON.parse(json)[0].t).toBe(evil[0].t);
    const html = renderPalette(evil);
    expect(html.match(/<\/script>/g)?.length).toBe(1);
    expect(html).not.toContain("<img");
  });

  it("is an accessible dialog with a combobox and a listbox", () => {
    const html = renderPalette([]);
    expect(html).toContain('role="dialog"');
    expect(html).toContain('aria-modal="true"');
    expect(html).toContain('role="combobox"');
    expect(html).toContain('aria-controls="pal-list"');
    expect(html).toContain('role="listbox"');
  });
});

function load() {
  const doc = {
    getElementById: () => null,
    querySelectorAll: () => [] as unknown[],
    addEventListener: () => {},
  };
  const ctx = vm.createContext({ document: doc, navigator: {}, location: {} });
  vm.runInContext(PALETTE_JS, ctx);
  return (items: PaletteItem[], q: string) =>
    (vm.runInContext(`paletteRank(${JSON.stringify(items)}, ${JSON.stringify(q)})`, ctx) as PaletteItem[]).map(
      (i) => i.t
    );
}

describe("paletteRank (browser script)", () => {
  const rank = load();
  const items = buildPaletteItems({
    admin: true,
    apps: [
      { id: "1", name: "weekplanner" },
      { id: "2", name: "security-intake" },
      { id: "3", name: "planner-old" },
    ],
  });

  it("does not start the wiring without the dialog (pages without a session)", () => {
    expect(() => load()).not.toThrow();
  });

  it("orders groups Go to, Apps, Actions", () => {
    const out = rank(items, "");
    expect(out.indexOf("Apps")).toBeLessThan(out.indexOf("weekplanner"));
    expect(out.indexOf("weekplanner")).toBeLessThan(out.indexOf("Toggle light or dark theme"));
  });

  it("caps the apps shown for an empty query at six", () => {
    const many = buildPaletteItems({
      admin: false,
      apps: Array.from({ length: 12 }, (_, i) => ({ id: String(i), name: "app-" + i })),
    });
    expect(rank(many, "").filter((t) => t.startsWith("app-")).length).toBe(6);
    expect(rank(many, "app").filter((t) => t.startsWith("app-")).length).toBe(12);
  });

  it("matches by label start before word start before substring", () => {
    const out = rank(items, "plan");
    expect(out.filter((t) => /plan/.test(t))).toEqual(["planner-old", "weekplanner"]);
  });

  it("finds a page by its extra search words", () => {
    expect(rank(items, "webhook")).toEqual(["Settings"]);
    expect(rank(items, "dark")).toEqual(["Toggle light or dark theme"]);
  });

  it("needs every word of the query to match", () => {
    expect(rank(items, "kev week")).toEqual([]);
    expect(rank(items, "kev quarantine")).toContain("Security");
  });

  it("is case-insensitive and returns nothing for gibberish", () => {
    expect(rank(items, "SETTINGS")).toEqual(["Settings"]);
    expect(rank(items, "zzzzqq")).toEqual([]);
  });
});
