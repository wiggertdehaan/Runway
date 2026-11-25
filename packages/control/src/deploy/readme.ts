/**
 * Read the README of an uploaded source tar and turn its first paragraph into
 * an app description.
 *
 * The tar is untrusted and control runs as root, so the same rules as
 * dep-apply.ts hold: the tar is never unpacked, members are listed and ONE is
 * read with `tar -xO`; only a regular file at the root named README.md (any
 * case) counts, never a link; the name goes after `--`; the read is bounded.
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseTarListing } from "./dep-apply.js";
import { descriptionFromReadme } from "../util/description.js";

/** The first paragraph is near the top; no need to read a huge README. */
const MAX_README_BYTES = 256 * 1024;
const TAR_ENV = { ...process.env, LC_ALL: "C", TZ: "UTC" };

/**
 * The description a source tar's README gives, or null (no README, not a
 * regular file, no paragraph, anything unreadable). Never throws.
 */
export function readmeDescription(tar: Buffer): string | null {
  let dir: string | null = null;
  try {
    dir = mkdtempSync(join(tmpdir(), "runway-readme-"));
    const tarPath = join(dir, "ctx.tar");
    writeFileSync(tarPath, tar);
    const members = parseTarListing(
      execFileSync("tar", ["--numeric-owner", "-tvf", tarPath], {
        env: TAR_ENV,
        maxBuffer: 64 * 1024 * 1024,
        stdio: ["ignore", "pipe", "ignore"],
      }).toString("utf8")
    );
    const hits = members.filter((m) => /^readme\.md$/i.test(m.path));
    // Exactly one candidate that is a regular file: with two (README.md and
    // readme.md) there is no telling which one the author means.
    if (hits.length !== 1 || !hits[0]!.regular) return null;
    let text: string;
    try {
      text = execFileSync("tar", ["-xOf", tarPath, "--", hits[0]!.name], {
        env: TAR_ENV,
        maxBuffer: MAX_README_BYTES,
        stdio: ["ignore", "pipe", "ignore"],
      }).toString("utf8");
    } catch (err) {
      // Larger than the cap: use what was read, the paragraph is at the top.
      const partial = (err as { stdout?: Buffer }).stdout;
      if (!partial || partial.length === 0) return null;
      text = partial.toString("utf8");
    }
    return descriptionFromReadme(text);
  } catch {
    return null;
  } finally {
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
}
