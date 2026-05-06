import { describe, it, expect } from "vitest";
import { slugify } from "./settings.js";

describe("slugify", () => {
  it("lowercases and replaces non-alphanumeric runs with single hyphens", () => {
    expect(slugify("My Bot")).toBe("my-bot");
    expect(slugify("Hello, World!")).toBe("hello-world");
    expect(slugify("foo___bar  baz")).toBe("foo-bar-baz");
  });

  it("trims leading/trailing hyphens", () => {
    expect(slugify("  --foo--  ")).toBe("foo");
    expect(slugify("!!!bar!!!")).toBe("bar");
  });

  it("caps length at 63 chars (DNS label limit)", () => {
    const long = "a".repeat(120);
    expect(slugify(long).length).toBe(63);
  });

  it("returns empty string for input with no alphanumerics", () => {
    expect(slugify("---")).toBe("");
    expect(slugify("   ")).toBe("");
  });

  it("preserves digits", () => {
    expect(slugify("App 42")).toBe("app-42");
  });
});
