/**
 * The short description of an app ("what is it, for whom, what for").
 *
 * Plain text only, at most MAX_DESCRIPTION characters. It is shown as text
 * everywhere (escaped, never markdown or HTML) and it can come out of a
 * README the deployer uploaded, so it is untrusted: everything that reaches
 * the database goes through `cleanDescription`, whatever the route.
 *
 * Pure: no database, no I/O.
 */

export const MAX_DESCRIPTION = 400;

/** Control characters except tab/newline are dropped; the rest of the cleaning is whitespace. */
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f\u0080-\u009f​-‏‪-‮⁦-⁩﻿]/g;

/** Collapse whitespace (also newlines) to single spaces and drop control / bidi characters. */
function flatten(text: string): string {
  return text.replace(CONTROL, "").replace(/\s+/g, " ").trim();
}

export type DescriptionCheck = { ok: true; value: string | null } | { ok: false; error: string };

/**
 * Validate a description somebody typed (dashboard, API, MCP). Empty or
 * whitespace-only clears it (value null). Too long is refused, not cut: the
 * author should decide what to leave out.
 */
export function cleanDescription(input: unknown): DescriptionCheck {
  if (input === null || input === undefined) return { ok: true, value: null };
  if (typeof input !== "string") return { ok: false, error: "description must be text" };
  // Refuse absurd input before doing any work on it.
  if (input.length > MAX_DESCRIPTION * 8) {
    return { ok: false, error: `description must be ${MAX_DESCRIPTION} characters or fewer` };
  }
  const text = flatten(input);
  if (text.length > MAX_DESCRIPTION) {
    return { ok: false, error: `description must be ${MAX_DESCRIPTION} characters or fewer (now ${text.length})` };
  }
  return { ok: true, value: text || null };
}

/** Cut at the last sentence end that fits; failing that, at a word, with an ellipsis. */
export function truncateAtSentence(text: string, max = MAX_DESCRIPTION): string {
  if (text.length <= max) return text;
  const head = text.slice(0, max);
  let cut = -1;
  const re = /[.!?](?=\s|$)/g;
  for (let m = re.exec(head); m; m = re.exec(head)) cut = m.index + 1;
  // A sentence end very early would leave next to nothing: prefer the word cut then.
  if (cut >= Math.min(60, max / 2)) return head.slice(0, cut).trim();
  const space = head.slice(0, max - 1).lastIndexOf(" ");
  const base = space > 0 ? head.slice(0, space) : head.slice(0, max - 1);
  return `${base.replace(/[\s,;:.\-–—]+$/, "")}…`;
}

/** Markdown inline syntax -> plain text. Not a parser: good enough for a README's first paragraph. */
function stripInline(text: string): string {
  return text
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "") // images
    .replace(/!\[([^\]]*)\]\[[^\]]*\]/g, "")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1") // inline links
    .replace(/\[([^\]]*)\]\[[^\]]*\]/g, "$1") // reference links
    .replace(/<(https?:\/\/[^>\s]+)>/g, "$1") // autolinks
    .replace(/<\/?[a-zA-Z][^>]*>/g, " ") // html tags
    .replace(/`+([^`]*)`+/g, "$1")
    .replace(/(\*\*|__)(.+?)\1/g, "$2")
    .replace(/(\*|_)(?=\S)(.+?)(?<=\S)\1/g, "$2")
    .replace(/~~(.+?)~~/g, "$1")
    .replace(/\\([\\`*_{}\[\]()#+\-.!>|~<])/g, "$1");
}

const RAW_PARAGRAPH_MAX = 4000;
const HEADING = /^\s{0,3}#{1,6}(\s|$)/;
const FENCE = /^\s{0,3}(```|~~~)/;
const SETEXT = /^\s{0,3}(=+|-+)\s*$/;
const RULE = /^\s{0,3}([-*_])(\s*\1){2,}\s*$/;
const TABLE = /^\s*\|.*\|\s*$/;
const LIST = /^\s{0,3}([-*+]|\d+[.)])\s/;

/**
 * The first real paragraph after the title of a README, as plain text of at
 * most MAX_DESCRIPTION characters, or null when there is none.
 *
 * Skipped: the title itself (ATX `# T` or a setext underline), badge / image /
 * HTML-only lines, other headings, code fences, tables, rules and lists. A
 * paragraph that is empty once the markdown is stripped is skipped too.
 */
export function descriptionFromReadme(markdown: string): string | null {
  if (typeof markdown !== "string" || !markdown) return null;
  const lines = markdown.replace(/^﻿/, "").replace(/\r\n?/g, "\n").split("\n");
  // Front matter ("---" ... "---") is metadata, not the README.
  let i = 0;
  if (lines[0]?.trim() === "---") {
    const end = lines.findIndex((l, n) => n > 0 && /^(---|\.\.\.)\s*$/.test(l));
    if (end > 0) i = end + 1;
  }

  let inFence = false;
  let paraChars = 0;
  let inComment = false;
  let para: string[] = [];
  const flush = (): string | null => {
    if (para.length === 0) return null;
    // Bounded before any pattern runs: the regexes below are not linear on
    // hostile input (a README of "[[[[..." must not cost seconds), and 4000
    // raw characters are far more than the 400 that are kept.
    const text = flatten(stripInline(para.join(" ").slice(0, RAW_PARAGRAPH_MAX)));
    para = [];
    paraChars = 0;
    // Needs real words: a lone "." or an emoji row is not a description.
    return /[\p{L}\p{N}]{2,}/u.test(text) ? text : null;
  };

  for (; i < lines.length; i++) {
    const line = lines[i]!.slice(0, RAW_PARAGRAPH_MAX);
    if (inComment) {
      if (line.includes("-->")) inComment = false;
      continue;
    }
    if (FENCE.test(line)) {
      inFence = !inFence;
      const got = flush();
      if (got) return truncateAtSentence(got);
      continue;
    }
    if (inFence) continue;
    if (/^\s*<!--/.test(line) && !line.includes("-->")) {
      inComment = true;
      continue;
    }
    if (line.trim() === "") {
      const got = flush();
      if (got) return truncateAtSentence(got);
      continue;
    }
    // Setext underline: the paragraph so far was a title, not text.
    if (para.length > 0 && SETEXT.test(line)) {
      para = [];
      continue;
    }
    if (HEADING.test(line) || RULE.test(line) || TABLE.test(line) || LIST.test(line)) {
      const got = flush();
      if (got) return truncateAtSentence(got);
      continue;
    }
    if (paraChars < RAW_PARAGRAPH_MAX) {
      const piece = line.slice(0, RAW_PARAGRAPH_MAX).replace(/^\s{0,3}>\s?/, "").trim();
      para.push(piece);
      paraChars += piece.length + 1;
    }
  }
  const got = flush();
  return got ? truncateAtSentence(got) : null;
}
