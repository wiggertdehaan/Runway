import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { countUsers } from "../db/users.js";
import { deleteSetting, getSetting, setSetting } from "../db/settings.js";

/**
 * S19: until the first admin exists, /setup would hand the admin account to
 * whoever got there first. The form now needs a one-time setup token that
 * only the person who installed Runway has seen:
 *
 * - `SETUP_TOKEN` in the environment (install.sh writes one into .env and
 *   prints it once), or, when that is unset or too short,
 * - a token control generates on its first start and prints in its log
 *   (`docker logs runway-control 2>&1 | grep -i "setup token"`).
 *
 * It exists only while there is no user. The moment the first account is
 * created the stored token is deleted and /setup stays closed as before.
 */

const STORED = "setup_token";
/** An environment token shorter than this is ignored (and a warning logged). */
export const MIN_ENV_TOKEN_LENGTH = 16;

export type SetupTokenSource = "env" | "generated";

export interface SetupToken {
  token: string;
  source: SetupTokenSource;
}

export function generateSetupToken(): string {
  return `rws_${randomBytes(24).toString("base64url")}`;
}

/** The environment token, if there is a usable one. */
export function envSetupToken(env: NodeJS.ProcessEnv = process.env): string | null {
  const raw = (env.SETUP_TOKEN ?? "").trim();
  return raw.length >= MIN_ENV_TOKEN_LENGTH ? raw : null;
}

/** True when SETUP_TOKEN is set but too short to be used. */
export function envSetupTokenTooShort(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = (env.SETUP_TOKEN ?? "").trim();
  return raw.length > 0 && raw.length < MIN_ENV_TOKEN_LENGTH;
}

/**
 * The token that currently guards /setup, or null when setup is closed
 * (an account exists). Creates and stores a generated one the first time.
 * Once an account exists any stored token is removed.
 */
export function currentSetupToken(env: NodeJS.ProcessEnv = process.env): SetupToken | null {
  if (countUsers() > 0) {
    if (getSetting(STORED) !== undefined) deleteSetting(STORED);
    return null;
  }
  const fromEnv = envSetupToken(env);
  if (fromEnv) return { token: fromEnv, source: "env" };
  let stored = getSetting(STORED);
  if (!stored) {
    stored = generateSetupToken();
    setSetting(STORED, stored);
  }
  return { token: stored, source: "generated" };
}

/**
 * Constant-time comparison. Both sides are hashed first so the length of the
 * expected token does not leak either. An empty input never matches.
 */
export function setupTokenMatches(input: string | undefined | null, expected: string): boolean {
  if (typeof input !== "string" || input.trim() === "" || expected === "") return false;
  const a = createHash("sha256").update(input.trim()).digest();
  const b = createHash("sha256").update(expected).digest();
  return timingSafeEqual(a, b);
}

/** Forget the stored token. Called when the first account has been created. */
export function clearSetupToken(): void {
  deleteSetting(STORED);
}

/**
 * Lines for the control log at startup (empty once an account exists). The
 * token is printed in full, on purpose: the log is how the person who runs
 * the server gets it, and it stops being useful as soon as setup is done.
 */
export function setupTokenAnnouncement(
  env: NodeJS.ProcessEnv = process.env,
  dashboardDomain: string | undefined = env.DASHBOARD_DOMAIN
): string[] {
  const current = currentSetupToken(env);
  const lines: string[] = [];
  if (envSetupTokenTooShort(env)) {
    lines.push(
      `SETUP_TOKEN is shorter than ${MIN_ENV_TOKEN_LENGTH} characters and is ignored.`
    );
  }
  if (!current) return lines;
  const url = dashboardDomain ? `https://${dashboardDomain}/setup` : "/setup";
  lines.push(
    "No admin account exists yet. Setup needs a one-time token.",
    `Setup token: ${current.token}`,
    `Open ${url} and enter it with the new admin's username and password.`,
    "It stops working as soon as the first admin exists."
  );
  return lines;
}
