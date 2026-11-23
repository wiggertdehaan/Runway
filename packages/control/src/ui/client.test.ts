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
