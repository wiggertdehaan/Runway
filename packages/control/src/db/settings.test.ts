import { describe, it, expect } from "vitest";
import {
  slugify,
  clampUploadMb,
  DEFAULT_MAX_UPLOAD_MB,
  MAX_UPLOAD_MB_CEILING,
} from "./settings.js";

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

describe("clampUploadMb", () => {
  it("returns the default for non-finite input", () => {
    expect(clampUploadMb(NaN)).toBe(DEFAULT_MAX_UPLOAD_MB);
    expect(clampUploadMb(Infinity)).toBe(DEFAULT_MAX_UPLOAD_MB);
  });

  it("passes valid values through unchanged", () => {
    expect(clampUploadMb(250)).toBe(250);
    expect(clampUploadMb(DEFAULT_MAX_UPLOAD_MB)).toBe(DEFAULT_MAX_UPLOAD_MB);
  });

  it("clamps to the floor of 1 MB", () => {
    expect(clampUploadMb(0)).toBe(1);
    expect(clampUploadMb(-50)).toBe(1);
  });

  it("clamps to the ceiling", () => {
    expect(clampUploadMb(MAX_UPLOAD_MB_CEILING + 1000)).toBe(MAX_UPLOAD_MB_CEILING);
  });
});
