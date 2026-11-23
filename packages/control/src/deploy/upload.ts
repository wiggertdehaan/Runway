/**
 * Receive a deploy upload without holding it in memory (S06).
 *
 * The body is streamed to a file with a hard byte cap, so a client that
 * sends no Content-Length (chunked) or lies about it cannot make control
 * buffer gigabytes before the size check. The file lives on the data
 * volume, not in /tmp: /tmp is a tmpfs in the compose file, i.e. RAM.
 */
import { createWriteStream } from "node:fs";
import { mkdir, readdir, rm, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { randomBytes } from "node:crypto";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";

const DB_PATH = process.env.DB_PATH || join(process.cwd(), "runway.db");
export const UPLOAD_DIR = process.env.UPLOAD_DIR || join(dirname(DB_PATH), "uploads");

export class UploadTooLargeError extends Error {
  readonly limit: number;
  constructor(limit: number) {
    super(`Upload exceeds limit of ${limit} bytes`);
    this.name = "UploadTooLargeError";
    this.limit = limit;
  }
}

export interface ReceivedUpload {
  path: string;
  bytes: number;
}

/**
 * Stream `body` to a new file. Throws UploadTooLargeError the moment more
 * than `maxBytes` have arrived (the partial file is removed). Any other
 * failure (client hung up) also removes the file and rethrows.
 */
export async function receiveUpload(
  body: ReadableStream<Uint8Array> | null,
  maxBytes: number,
  dir: string = UPLOAD_DIR,
): Promise<ReceivedUpload> {
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const path = join(dir, `upload-${Date.now()}-${randomBytes(6).toString("hex")}.tar`);
  if (!body) {
    // No body at all: an empty file, so the caller reports "Empty upload".
    await rm(path, { force: true });
    return { path: "", bytes: 0 };
  }

  let bytes = 0;
  const counter = new Transform({
    transform(chunk: Buffer, _enc, cb) {
      bytes += chunk.length;
      if (bytes > maxBytes) cb(new UploadTooLargeError(maxBytes));
      else cb(null, chunk);
    },
  });

  try {
    await pipeline(
      Readable.fromWeb(body as unknown as import("node:stream/web").ReadableStream),
      counter,
      createWriteStream(path, { mode: 0o600 }),
    );
  } catch (err) {
    await rm(path, { force: true }).catch(() => {});
    throw err;
  }
  return { path, bytes };
}

/**
 * Remove upload files older than `maxAgeMs` (default 1 hour). A deploy removes
 * its own file in every normal and error path; this only catches what a crash
 * or a restart in the middle of an upload left behind. Returns how many it removed.
 */
export async function cleanupStaleUploads(
  dir: string = UPLOAD_DIR,
  maxAgeMs: number = 60 * 60 * 1000,
  now: number = Date.now(),
): Promise<number> {
  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    return 0; // no upload folder yet
  }
  let removed = 0;
  for (const name of names) {
    if (!/^upload-\d+-[0-9a-f]+\.tar$/.test(name)) continue;
    const p = join(dir, name);
    try {
      const st = await stat(p);
      if (now - st.mtimeMs > maxAgeMs) {
        await rm(p, { force: true });
        removed += 1;
      }
    } catch {
      /* gone already */
    }
  }
  return removed;
}
