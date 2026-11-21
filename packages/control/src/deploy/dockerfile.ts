import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Read one file (default `Dockerfile`) out of a build-context tar
 * without extracting anything to disk beyond the temp tar itself.
 * Uses execFile with an argument vector (no shell). Returns null when
 * the member is missing or unreadable.
 */
export function readDockerfileFromTar(
  tar: Buffer,
  name = "Dockerfile"
): string | null {
  const dir = mkdtempSync(join(tmpdir(), "runway-df-"));
  try {
    const tarPath = join(dir, "ctx.tar");
    writeFileSync(tarPath, tar);
    for (const member of [name, `./${name}`]) {
      try {
        const out = execFileSync("tar", ["-xOf", tarPath, member], {
          maxBuffer: 2 * 1024 * 1024,
          stdio: ["ignore", "pipe", "ignore"],
        });
        return out.toString("utf8");
      } catch {
        /* try the next spelling */
      }
    }
    return null;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
