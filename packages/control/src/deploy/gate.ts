import { kevFindings } from "./kev.js";
import type { Finding, ScanResult } from "./scan.js";

export interface GateVerdict {
  allow: boolean;
  reason: string;
}

/**
 * Pure: may a rebuilt image replace the running one? Yes iff its scan is
 * not worse than the running version: no CRITICAL CVE that the running
 * image doesn't have, and no actively exploited (KEV) CVE it doesn't
 * have. Fewer or equal findings always pass, even when the app's own
 * scan threshold would have blocked a fresh deploy of the same image
 * (the running version carries those findings too). Without a trustworthy
 * scan on either side we cannot compare, so we refuse.
 */
export function evaluateRebuildGate(
  current: Finding[] | null,
  next: ScanResult,
  kev: Set<string>
): GateVerdict {
  if (next.status === "skipped") {
    return { allow: false, reason: "scan of the new build unavailable, cannot verify it is not worse" };
  }
  if (current === null) {
    return { allow: false, reason: "no scan of the running version to compare against" };
  }
  const cur = current.filter((f) => f.source === "image");
  const nxt = next.findings.filter((f) => f.source === "image");
  const curCrit = new Set(cur.filter((f) => f.severity === "CRITICAL").map((f) => f.id));
  const curIds = new Set(cur.map((f) => f.id.toUpperCase()));

  const newCrit = [...new Set(nxt.filter((f) => f.severity === "CRITICAL" && !curCrit.has(f.id)).map((f) => f.id))];
  const newKev = [...new Set(
    kevFindings(nxt, kev).map((f) => f.id.toUpperCase()).filter((id) => !curIds.has(id))
  )];

  const list = (ids: string[]) => ids.slice(0, 3).join(", ") + (ids.length > 3 ? `, +${ids.length - 3} more` : "");
  const problems: string[] = [];
  if (newCrit.length) problems.push(`${newCrit.length} new critical (${list(newCrit)})`);
  if (newKev.length) problems.push(`${newKev.length} new actively exploited (${list(newKev)})`);
  if (problems.length) {
    return { allow: false, reason: `new build is worse than the running version: ${problems.join("; ")}` };
  }
  return { allow: true, reason: "not worse than the running version" };
}

/**
 * Findings worth escalating a base for: an actively exploited (KEV) CVE,
 * or a CRITICAL that has a fix somewhere. Returns unique CVE ids.
 */
export function escalationTargets(findings: Finding[], kev: Set<string>): string[] {
  const image = findings.filter((f) => f.source === "image");
  const ids = new Set<string>();
  for (const f of kevFindings(image, kev)) ids.add(f.id.toUpperCase());
  for (const f of image) {
    if (f.severity === "CRITICAL" && f.fixedVersion) ids.add(f.id.toUpperCase());
  }
  return [...ids];
}

/**
 * Gate for one minor-escalation candidate: not worse than what runs now
 * (same rule as any rebuild) AND every targeted finding is gone. A minor
 * that only fixes some of them is not worth an automatic minor jump.
 */
export function evaluateEscalationGate(
  current: Finding[] | null,
  next: ScanResult,
  kev: Set<string>,
  targets: string[],
  line: string
): GateVerdict {
  const base = evaluateRebuildGate(current, next, kev);
  if (!base.allow) return base;
  const present = new Set(
    next.findings.filter((f) => f.source === "image").map((f) => f.id.toUpperCase())
  );
  const left = targets.filter((id) => present.has(id));
  if (left.length > 0) {
    const list = left.slice(0, 3).join(", ") + (left.length > 3 ? `, +${left.length - 3} more` : "");
    return { allow: false, reason: `minor ${line} still has ${list}` };
  }
  return { allow: true, reason: `minor ${line} resolves all ${targets.length} targeted finding(s)` };
}

/**
 * A quarantined app may only go back online with a build that is free of
 * actively exploited CVEs; "not worse" is not enough there.
 */
export function requireKevFree(
  verdict: GateVerdict,
  next: ScanResult,
  kev: Set<string>
): GateVerdict {
  if (!verdict.allow) return verdict;
  const left = [
    ...new Set(
      kevFindings(next.findings.filter((f) => f.source === "image"), kev).map((f) => f.id.toUpperCase())
    ),
  ];
  if (left.length === 0) return verdict;
  return {
    allow: false,
    reason: `app is quarantined and the new build still has actively exploited ${left.slice(0, 3).join(", ")}${left.length > 3 ? ` (+${left.length - 3} more)` : ""}`,
  };
}
