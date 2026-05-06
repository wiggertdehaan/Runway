import { db } from "./index.js";
import type { Finding, ScanStatus, ScanCounts } from "../deploy/scan.js";

export interface PeriodicScan {
  id: number;
  app_id: string;
  image_tag: string;
  scan_status: ScanStatus;
  scan_summary: string;
  scan_report: string | null;
  error: string | null;
  created_at: string;
}

export interface PeriodicScanInput {
  app_id: string;
  image_tag: string;
  scan_status: ScanStatus;
  counts: ScanCounts;
  findings: Finding[];
  error?: string | null;
}

const MAX_FINDINGS_STORED = 500;

export function insertPeriodicScan(input: PeriodicScanInput): number {
  const summary = JSON.stringify({ counts: input.counts });
  // Cap the stored report to keep the row small; the live findings
  // are the actionable bit, the rest is stats noise.
  const report = JSON.stringify({
    findings: input.findings.slice(0, MAX_FINDINGS_STORED),
    truncated: input.findings.length > MAX_FINDINGS_STORED,
    total_findings: input.findings.length,
  });
  const result = db
    .prepare(
      `INSERT INTO app_periodic_scans
         (app_id, image_tag, scan_status, scan_summary, scan_report, error)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .run(
      input.app_id,
      input.image_tag,
      input.scan_status,
      summary,
      report,
      input.error ?? null,
    );
  return Number(result.lastInsertRowid);
}

export function getLatestPeriodicScan(appId: string): PeriodicScan | undefined {
  return db
    .prepare(
      `SELECT * FROM app_periodic_scans
       WHERE app_id = ?
       ORDER BY created_at DESC
       LIMIT 1`,
    )
    .get(appId) as unknown as PeriodicScan | undefined;
}

export function getLatestPeriodicScanFindings(appId: string): Finding[] {
  const row = getLatestPeriodicScan(appId);
  if (!row?.scan_report) return [];
  try {
    const parsed = JSON.parse(row.scan_report) as { findings?: Finding[] };
    return parsed.findings ?? [];
  } catch {
    return [];
  }
}
