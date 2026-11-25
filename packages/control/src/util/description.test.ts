import { describe, expect, it } from "vitest";
import { cleanDescription, descriptionFromReadme, MAX_DESCRIPTION, truncateAtSentence } from "./description.js";

describe("cleanDescription", () => {
  it("accepts plain text and trims / flattens whitespace", () => {
    expect(cleanDescription("  Daily KPI digest\n for the   sales team. ")).toEqual({
      ok: true,
      value: "Daily KPI digest for the sales team.",
    });
  });
  it("null, undefined, empty and blank all clear it", () => {
    for (const v of [null, undefined, "", "   \n\t "]) expect(cleanDescription(v)).toEqual({ ok: true, value: null });
  });
  it("refuses anything that is not text", () => {
    for (const v of [5, {}, [], true]) expect(cleanDescription(v).ok).toBe(false);
  });
  it("takes exactly MAX_DESCRIPTION characters and refuses one more (not cut)", () => {
    expect(cleanDescription("a".repeat(MAX_DESCRIPTION))).toEqual({ ok: true, value: "a".repeat(MAX_DESCRIPTION) });
    const r = cleanDescription("a".repeat(MAX_DESCRIPTION + 1));
    expect(r.ok).toBe(false);
  });
  it("refuses a huge input without working on it", () => {
    expect(cleanDescription("x ".repeat(100_000)).ok).toBe(false);
  });
  it("drops control, zero-width and bidi characters", () => {
    expect(cleanDescription("a\u0000b‮c​d\u0007e")).toEqual({ ok: true, value: "abcde" });
  });
  it("keeps markup as text: escaping is the renderer's job, not a silent rewrite", () => {
    expect(cleanDescription("<img src=x onerror=alert(1)> & co")).toEqual({
      ok: true,
      value: "<img src=x onerror=alert(1)> & co",
    });
  });
});

describe("truncateAtSentence", () => {
  it("leaves short text alone", () => {
    expect(truncateAtSentence("Short one.")).toBe("Short one.");
  });
  it("cuts at the last sentence end that fits", () => {
    const text = `${"First sentence is here. ".repeat(10)}Tail without end ${"x".repeat(300)}`;
    const out = truncateAtSentence(text);
    expect(out.length).toBeLessThanOrEqual(MAX_DESCRIPTION);
    expect(out.endsWith(".")).toBe(true);
  });
  it("falls back to a word cut with an ellipsis, within the limit", () => {
    const out = truncateAtSentence("word ".repeat(200));
    expect(out.length).toBeLessThanOrEqual(MAX_DESCRIPTION);
    expect(out.endsWith("…")).toBe(true);
    expect(out).not.toMatch(/\s…$/);
  });
  it("cuts a single endless token at the limit", () => {
    const out = truncateAtSentence("x".repeat(1000));
    expect(out.length).toBe(MAX_DESCRIPTION);
    expect(out.endsWith("…")).toBe(true);
  });
  it("does not cut on a dot inside a version number or domain", () => {
    const text = `Runs on v1.2.3 and app.example.com ${"padding ".repeat(60)}`;
    const out = truncateAtSentence(text);
    expect(out).not.toMatch(/v1\.$|app\.$/);
  });
});

describe("descriptionFromReadme", () => {
  it("takes the first paragraph after the title", () => {
    const md = "# Rosa Cockpit\n\nDashboard for the field team to follow open jobs.\nUpdated daily.\n\n## Install\n\nnpm i\n";
    expect(descriptionFromReadme(md)).toBe("Dashboard for the field team to follow open jobs. Updated daily.");
  });
  it("skips badges, images and html between title and text", () => {
    const md = [
      "# Tool",
      "",
      "[![Build](https://x/y.svg)](https://x)  [![npm](https://x/z.svg)](https://x)",
      "",
      '<p align="center"><img src="logo.png"></p>',
      "",
      "![banner](banner.png)",
      "",
      "Clears the **item** queue for `Roamler` reviewers, see [docs](https://example.com/d).",
    ].join("\n");
    expect(descriptionFromReadme(md)).toBe("Clears the item queue for Roamler reviewers, see docs.");
  });
  it("handles a setext title and CRLF", () => {
    expect(descriptionFromReadme("Title\r\n=====\r\n\r\nWhat it does.\r\n")).toBe("What it does.");
  });
  it("skips front matter and html comments", () => {
    const md = "---\ntitle: x\n---\n# T\n<!-- hidden\nmore -->\n\nReal text here.";
    expect(descriptionFromReadme(md)).toBe("Real text here.");
  });
  it("skips code fences, tables and lists before the first paragraph", () => {
    const md = "# T\n\n```\nnpm i\n```\n\n| a | b |\n|---|---|\n\n- one\n- two\n\nFinally prose.";
    expect(descriptionFromReadme(md)).toBe("Finally prose.");
  });
  it("README with only a title or nothing readable gives null", () => {
    expect(descriptionFromReadme("# Only a title\n")).toBeNull();
    expect(descriptionFromReadme("# T\n\n## Install\n\n- a\n")).toBeNull();
    expect(descriptionFromReadme("# T\n\n![x](y.png)\n\n🚀\n")).toBeNull();
    expect(descriptionFromReadme("")).toBeNull();
    expect(descriptionFromReadme("\n\n   \n")).toBeNull();
  });
  it("strips markdown to plain text and leaves no tags", () => {
    const out = descriptionFromReadme("# T\n\n<b>Bold</b> and <script>alert(1)</script> *em* ~~gone~~ [a](javascript:x)")!;
    expect(out).not.toMatch(/[<>]/);
    expect(out).toContain("Bold");
    expect(out).toContain("em");
  });
  it("is cut at a sentence end and never longer than the limit", () => {
    const md = `# T\n\n${"This is a sentence about the app. ".repeat(40)}`;
    const out = descriptionFromReadme(md)!;
    expect(out.length).toBeLessThanOrEqual(MAX_DESCRIPTION);
    expect(out.endsWith(".")).toBe(true);
  });
  it("copes with a hostile giant line without hanging", () => {
    const t = Date.now();
    const out = descriptionFromReadme(`# T\n\n${"[".repeat(200_000)}`);
    expect(Date.now() - t).toBeLessThan(2000);
    expect(out === null || out.length <= MAX_DESCRIPTION).toBe(true);
  });
});
