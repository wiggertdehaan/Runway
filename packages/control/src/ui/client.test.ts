import vm from "node:vm";
import { describe, expect, it } from "vitest";
import { CLIENT_JS, PREPAINT_JS } from "./client.js";

/** Minimal DOM stub: enough for the scripts to load, `body` still null. */
function stubWindow() {
  const listeners: Record<string, Array<(e: unknown) => void>> = {};
  const attrs = new Map<string, string>();
  const document = {
    body: null as unknown,
    documentElement: {
      getAttribute: (k: string) => attrs.get(k) ?? null,
      setAttribute: (k: string, v: string) => void attrs.set(k, v),
      removeAttribute: (k: string) => void attrs.delete(k),
    },
    addEventListener: (t: string, f: (e: unknown) => void) => void (listeners[t] ??= []).push(f),
    querySelectorAll: () => [] as unknown[],
    getElementById: () => null,
  };
  const ctx = vm.createContext({
    document,
    location: { pathname: "/" },
    localStorage: { getItem: () => null, setItem: () => {} },
  });
  return { ctx, listeners, attrs };
}

describe("dashboard client script", () => {
  it("loads without touching document.body (U7: it used to throw in <head>)", () => {
    const { ctx, listeners } = stubWindow();
    expect(() => vm.runInContext(CLIENT_JS, ctx)).not.toThrow();
    // The swap listener hangs off document, so it survives the 5s poll.
    expect(listeners["htmx:afterSwap"]?.length).toBe(1);
  });

  it("re-applies the search filter after the apps poll swaps in fresh cards", () => {
    const { ctx, listeners } = stubWindow();
    vm.runInContext(CLIENT_JS, ctx);
    let filtered = 0;
    (ctx as Record<string, unknown>).filterApps = () => void filtered++;
    // ignored swap targets must not trigger a refilter
    listeners["htmx:afterSwap"][0]({ detail: { target: { id: "other" } } });
    expect(filtered).toBe(0);
    listeners["htmx:afterSwap"][0]({ detail: { target: { id: "apps-live" } } });
    expect(filtered).toBe(1);
  });

  it("pre-paint snippet only reads storage and sets attributes on <html>", () => {
    expect(PREPAINT_JS).not.toContain("document.body");
    const { ctx } = stubWindow();
    expect(() => vm.runInContext(PREPAINT_JS, ctx)).not.toThrow();
  });
});

/** Tiny element stub with attributes and a style bag. */
function el(attrs: Record<string, string>) {
  const a = new Map(Object.entries(attrs));
  return {
    style: { display: "" } as { display: string },
    getAttribute: (k: string) => a.get(k) ?? null,
    setAttribute: (k: string, v: string) => void a.set(k, v),
    closest(sel: string) {
      return sel === "[data-chip]" && a.has("data-chip") ? this : null;
    },
  };
}

function homeDom(search = "") {
  const rows = [
    el({ "data-app-row": "", "data-name": "Shop", "data-domain": "shop.example.com", "data-status": "live", "data-attn": "0" }),
    el({ "data-app-row": "", "data-name": "Blog", "data-domain": "blog.example.com", "data-status": "live", "data-attn": "1" }),
    el({ "data-app-row": "", "data-name": "Old", "data-domain": "", "data-status": "offline", "data-attn": "1" }),
  ];
  const chipKeys = ["all", "attention", "live", "offline"];
  let chips = chipKeys.map((k) => el({ "data-chip": k, "aria-pressed": "false" }));
  const searchBox = { value: search };
  const noMatch = el({});
  const listeners: Record<string, Array<(e: unknown) => void>> = {};
  const document = {
    body: null as unknown,
    documentElement: { getAttribute: () => null, setAttribute() {}, removeAttribute() {} },
    addEventListener: (t: string, f: (e: unknown) => void) => void (listeners[t] ??= []).push(f),
    querySelectorAll(sel: string) {
      const list = sel === "[data-app-row]" ? rows : sel === "[data-chip]" ? chips : [];
      return Object.assign([...list], {});
    },
    getElementById: (id: string) => (id === "app-search" ? searchBox : id === "no-match" ? noMatch : null),
  };
  const ctx = vm.createContext({ document, location: { pathname: "/" }, localStorage: { getItem: () => null, setItem: () => {} } });
  vm.runInContext(CLIENT_JS, ctx);
  const visible = () => rows.filter((r) => r.style.display !== "none").map((r) => r.getAttribute("data-name"));
  const pressed = () => chips.filter((c) => c.getAttribute("aria-pressed") === "true").map((c) => c.getAttribute("data-chip"));
  const click = (key: string) => {
    const target = chips.find((c) => c.getAttribute("data-chip") === key)!;
    for (const f of listeners["click"] ?? []) f({ target });
  };
  const swap = (newChips?: string[]) => {
    // The poll replaces the whole region, chips included.
    if (newChips) chips = newChips.map((k) => el({ "data-chip": k, "aria-pressed": "false" }));
    for (const f of listeners["htmx:afterSwap"] ?? []) f({ detail: { target: { id: "apps-live" } } });
  };
  return { ctx, searchBox, noMatch, visible, pressed, click, swap, run: () => vm.runInContext("filterApps()", ctx) };
}

describe("home filter (search + status chips)", () => {
  it("shows every app with no search and the All chip", () => {
    const d = homeDom();
    d.run();
    expect(d.visible()).toEqual(["Shop", "Blog", "Old"]);
    expect(d.pressed()).toEqual(["all"]);
  });
  it("filters by name or domain, case-insensitively", () => {
    const d = homeDom("BLOG");
    d.run();
    expect(d.visible()).toEqual(["Blog"]);
    d.searchBox.value = "shop.example";
    d.run();
    expect(d.visible()).toEqual(["Shop"]);
  });
  it("filters by a state chip and by Needs attention", () => {
    const d = homeDom();
    d.click("live");
    expect(d.visible()).toEqual(["Shop", "Blog"]);
    expect(d.pressed()).toEqual(["live"]);
    d.click("attention");
    expect(d.visible()).toEqual(["Blog", "Old"]);
    d.click("offline");
    expect(d.visible()).toEqual(["Old"]);
  });
  it("combines the search with the chip", () => {
    const d = homeDom("blog");
    d.click("offline");
    expect(d.visible()).toEqual([]);
    expect(d.noMatch.style.display).toBe("");
    d.click("attention");
    expect(d.visible()).toEqual(["Blog"]);
    expect(d.noMatch.style.display).toBe("none");
  });
  it("keeps the search and the chip after the 5s poll swaps the rows (U7)", () => {
    const d = homeDom("o");
    d.click("attention");
    expect(d.visible()).toEqual(["Blog", "Old"]);
    d.swap(["all", "attention", "live", "offline"]);
    expect(d.pressed()).toEqual(["attention"]);
    expect(d.visible()).toEqual(["Blog", "Old"]);
  });
  it("falls back to All when the active chip no longer exists", () => {
    const d = homeDom();
    d.click("offline");
    d.swap(["all", "live"]);
    expect(d.pressed()).toEqual(["all"]);
    expect(d.visible()).toEqual(["Shop", "Blog", "Old"]);
  });
});
