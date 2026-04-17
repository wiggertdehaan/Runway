/**
 * Pre-build inspection of the uploaded build context. Complements the
 * Trivy scan (which looks at the built image and secret patterns) with
 * a small set of byte-level rejects that catch the most common
 * build-time SSRF patterns BEFORE the build reaches BuildKit.
 *
 * Rationale: buildkit now sits on its own isolated Docker network
 * (`runway-build`), so a RUN step can no longer reach the control
 * plane or other apps over Docker DNS. It CAN still hit the cloud
 * metadata endpoint on the host network namespace (169.254.169.254
 * and friends). Fully blocking that requires host iptables or custom
 * CNI config for buildkit — we document that as optional hardening.
 * Until then, scanning the uploaded tar for the well-known metadata
 * targets raises the bar significantly for minimal false-positive risk:
 * the patterns below effectively never appear in legitimate build
 * contexts.
 */

const BLOCKED_PATTERNS: { needle: Buffer; label: string }[] = [
  { needle: Buffer.from("169.254.169.254"), label: "cloud metadata (link-local)" },
  { needle: Buffer.from("metadata.google.internal"), label: "GCE metadata hostname" },
  { needle: Buffer.from("metadata.azure.com"), label: "Azure metadata hostname" },
  { needle: Buffer.from("100.100.100.200"), label: "Alibaba Cloud metadata" },
  { needle: Buffer.from("fd00:ec2::254"), label: "AWS IMDS (IPv6)" },
];

export class PreflightRejectedError extends Error {
  pattern: string;
  constructor(pattern: string) {
    super(
      `Build context references ${pattern}. Cloud metadata endpoints are blocked at upload time.`
    );
    this.pattern = pattern;
  }
}

export function preflightCheckTar(tar: Buffer): void {
  for (const { needle, label } of BLOCKED_PATTERNS) {
    if (tar.includes(needle)) {
      throw new PreflightRejectedError(label);
    }
  }
}
