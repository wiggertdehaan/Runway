import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

/**
 * RFC 6238 TOTP implementation built on node:crypto. No external
 * dependencies. Default parameters match what every standard
 * authenticator app (Google Authenticator, 1Password, Authy, …)
 * expects: SHA-1, 30-second period, 6-digit codes.
 */

const BASE32_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
const STEP_SECONDS = 30;
const DIGITS = 6;

export function generateTotpSecret(bytes = 20): string {
  return base32Encode(randomBytes(bytes));
}

/**
 * Build an otpauth:// URI that 1Password / Google Authenticator /
 * Authy can consume as a QR code or a manual paste.
 */
export function totpUri(
  secret: string,
  account: string,
  issuer: string
): string {
  const label = encodeURIComponent(`${issuer}:${account}`);
  const params = new URLSearchParams({
    secret,
    issuer,
    algorithm: "SHA1",
    digits: String(DIGITS),
    period: String(STEP_SECONDS),
  });
  return `otpauth://totp/${label}?${params.toString()}`;
}

/**
 * Verify a 6-digit code against the stored secret. Accepts the
 * current step plus one step of drift on either side (~90s window)
 * to absorb client/server clock skew. Comparison is constant-time.
 */
export function verifyTotp(
  secret: string,
  code: string,
  now = Date.now()
): boolean {
  if (!/^\d{6}$/.test(code)) return false;

  let key: Buffer;
  try {
    key = base32Decode(secret);
  } catch {
    return false;
  }

  const counter = Math.floor(now / 1000 / STEP_SECONDS);
  const expected = Buffer.from(code, "utf8");

  for (let drift = -1; drift <= 1; drift++) {
    const candidate = Buffer.from(hotp(key, counter + drift), "utf8");
    if (
      candidate.length === expected.length &&
      timingSafeEqual(candidate, expected)
    ) {
      return true;
    }
  }
  return false;
}

/**
 * HOTP (RFC 4226) — HMAC-SHA1 truncated to 6 digits. TOTP = HOTP
 * with the counter set to floor(time / period).
 */
function hotp(key: Buffer, counter: number): string {
  const buf = Buffer.alloc(8);
  // 8-byte big-endian counter. Split across two 32-bit writes
  // because JavaScript numbers cannot hold 64-bit integers cleanly.
  const high = Math.floor(counter / 0x100000000);
  const low = counter >>> 0;
  buf.writeUInt32BE(high, 0);
  buf.writeUInt32BE(low, 4);

  const digest = createHmac("sha1", key).update(buf).digest();
  const offset = digest[digest.length - 1]! & 0x0f;
  const binary =
    ((digest[offset]! & 0x7f) << 24) |
    ((digest[offset + 1]! & 0xff) << 16) |
    ((digest[offset + 2]! & 0xff) << 8) |
    (digest[offset + 3]! & 0xff);

  const mod = binary % 10 ** DIGITS;
  return mod.toString().padStart(DIGITS, "0");
}

function base32Encode(buf: Buffer): string {
  let bits = 0;
  let value = 0;
  let output = "";
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      output += BASE32_ALPHABET[(value >>> (bits - 5)) & 0x1f];
      bits -= 5;
    }
  }
  if (bits > 0) {
    output += BASE32_ALPHABET[(value << (5 - bits)) & 0x1f];
  }
  return output;
}

function base32Decode(input: string): Buffer {
  const clean = input.replace(/=+$/, "").toUpperCase().replace(/\s/g, "");
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const ch of clean) {
    const idx = BASE32_ALPHABET.indexOf(ch);
    if (idx < 0) throw new Error(`Invalid base32 character: ${ch}`);
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}
