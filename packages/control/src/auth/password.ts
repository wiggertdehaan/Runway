import { randomBytes, scrypt, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";

const scryptAsync = promisify(scrypt);

const SALT_BYTES = 16;
const KEY_LEN = 64;

/**
 * Hash a password using scrypt. Returns a string of the form
 * `scrypt$<salt-hex>$<hash-hex>` suitable for storage in SQLite.
 */
export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(SALT_BYTES);
  const derived = (await scryptAsync(password, salt, KEY_LEN)) as Buffer;
  return `scrypt$${salt.toString("hex")}$${derived.toString("hex")}`;
}

/**
 * Verify a password against a stored hash. Uses timing-safe comparison.
 */
export async function verifyPassword(
  password: string,
  stored: string
): Promise<boolean> {
  const parts = stored.split("$");
  if (parts.length !== 3 || parts[0] !== "scrypt") return false;

  const salt = Buffer.from(parts[1]!, "hex");
  const expected = Buffer.from(parts[2]!, "hex");
  const derived = (await scryptAsync(password, salt, expected.length)) as Buffer;

  return (
    derived.length === expected.length && timingSafeEqual(derived, expected)
  );
}
