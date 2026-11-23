/**
 * One manual rescan at a time. A rescan runs Trivy over the whole image and
 * the request waits for it, so when owners may start one too, a second click
 * (or many) must not pile up scans on the host. Same spirit as the rebuild
 * limit. The daily sweep calls rescanApp directly and is not affected.
 */
let active: string | null = null;

/** The app being rescanned right now, or null. */
export function activeRescan(): string | null {
  return active;
}

/** True when the slot was free and is now yours; call endRescan() when done. */
export function tryBeginRescan(appId: string): boolean {
  if (active !== null) return false;
  active = appId;
  return true;
}

export function endRescan(appId: string): void {
  if (active === appId) active = null;
}
