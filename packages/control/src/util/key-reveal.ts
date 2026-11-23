/**
 * Showing a freshly made key (S10, S11).
 *
 * Keys are stored hashed, so the dashboard cannot show an old one. For the
 * moment right after an app is created or its key is rotated the plaintext is
 * kept in MEMORY ONLY, for the one person who asked for it, so the page can
 * show it (the home page re-renders every few seconds, so it cannot be a
 * single read). It is never written to the database, a log or a cookie. It
 * disappears after a few minutes, on a restart, or when it is dismissed.
 */

const TTL_MS = 10 * 60 * 1000;
const MAX_ENTRIES = 500;

interface Reveal {
  key: string;
  userId: string;
  expiresAt: number;
}

const reveals = new Map<string, Reveal>();

function sweep(now: number): void {
  for (const [id, r] of reveals) if (r.expiresAt <= now) reveals.delete(id);
  // A bound, so a flood of creations cannot grow the map without end.
  while (reveals.size > MAX_ENTRIES) {
    const oldest = reveals.keys().next().value;
    if (oldest === undefined) break;
    reveals.delete(oldest);
  }
}

/** Remember a new key for the user who made it. Replaces an earlier one for the app. */
export function rememberKey(appId: string, userId: string, key: string, now = Date.now()): void {
  sweep(now);
  reveals.set(appId, { key, userId, expiresAt: now + TTL_MS });
}

/** The key, only for the user it was made for and only while it is fresh. */
export function peekKey(appId: string, userId: string, now = Date.now()): string | null {
  const r = reveals.get(appId);
  if (!r) return null;
  if (r.expiresAt <= now) {
    reveals.delete(appId);
    return null;
  }
  return r.userId === userId ? r.key : null;
}

/** Forget it now (the person has copied it, or the key was replaced). */
export function forgetKey(appId: string): void {
  reveals.delete(appId);
}

/** For tests. */
export function clearKeyReveals(): void {
  reveals.clear();
}

export function keyRevealSize(): number {
  return reveals.size;
}
