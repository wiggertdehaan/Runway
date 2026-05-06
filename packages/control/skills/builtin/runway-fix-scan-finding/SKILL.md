---
name: runway-fix-scan-finding
description: Use when a Runway deploy returns scan findings (warned or blocked). Diagnoses image CVEs, hardcoded secrets, and Dockerfile misconfigurations and proposes targeted fixes.
---

# Runway fix-scan-finding

A Runway deploy was scanned by Trivy and produced findings. Each
finding has:

- `severity` — `LOW` / `MEDIUM` / `HIGH` / `CRITICAL` / `UNKNOWN`
- `source` — `image` (CVE in OS package or library), `secret` (token
  in source), or `misconfig` (Dockerfile rule)
- `id` — CVE identifier or rule id
- `pkg`, `version`, `fixedVersion` — only for `image`

## Decide whether to act

- `scan.status: "passed"` — nothing to do.
- `scan.status: "warned"` — deploy went through. Surface the
  highest-severity findings to the user but **don't fix
  proactively** unless the user asks or `scan_threshold` is about
  to tighten.
- `scan.status: "blocked"` (HTTP 409) — new container was **not**
  started. Previous version keeps serving. Findings *must* be fixed
  or the user must lower `scan_threshold`.

## Image vulnerabilities

If `fixedVersion` is set:
- **OS package on Debian/Ubuntu**: rebuild the image — the
  `apt-get upgrade` step in the Dockerfile usually picks up the
  fix. If it doesn't, the package is essential and Debian hasn't
  patched it yet → switch to Alpine.
- **Language dependency** (npm, pip, go modules): bump the package
  version in the lock file to `>= fixedVersion` and redeploy.

If `fixedVersion` is empty:
- The maintainer hasn't released a fix. Options:
  - Switch the base image to a distro that doesn't include the
    package (Alpine instead of Debian-slim is the most common
    swap).
  - Lower `scan_threshold` for this app (admin/owner decision).
  - If the package is unused in your code path, see if you can
    drop the dependency entirely.

Common base-image swap that resolves a cluster of HIGH findings:

```diff
- FROM python:3.12-slim
+ FROM python:3.12-alpine
```

Note: Alpine uses `apk` and `musl`. Some pip packages need
`apk add --no-cache build-base linux-headers libffi-dev` in a
builder stage. See `runway-bootstrap` for the multi-stage Alpine
template.

## Secret findings

Trivy spotted what looks like a hardcoded credential. Fix:

1. Move the value to a Runway env var via `/api/v1/app/env`.
2. Remove the literal from source (and from `git history` if it
   was committed — `git filter-repo` or BFG).
3. **Rotate the credential** at the upstream provider — assume the
   previous value is compromised.
4. Add the file pattern to `.dockerignore` if it shouldn't have
   been in the build context.

Note: the `AKIAIOSFODNN7EXAMPLE` AWS key is a documented example
and is whitelisted by the scanner — if you see it flagged, you're
seeing a false alarm.

## Misconfiguration findings

Common rule fixes:

- **`DS002` running as root** — add `RUN addgroup --system app && \
  adduser --system --ingroup app app` and `USER app` before
  `EXPOSE`. See `runway-bootstrap` for runtime-specific patterns.
- **`DS026` no HEALTHCHECK** — the deployed container can be
  health-checked at the gateway level via Runway's
  `/api/v1/app/healthcheck` endpoint, which is the recommended
  approach. The Dockerfile-level `HEALTHCHECK` is optional.
- **`DS001` ADD with remote URL** — replace `ADD https://...` with
  a `RUN curl -fsSL ... -o ...` step. ADD-from-URL doesn't verify
  TLS or hashes.

## Inspect the full report

If the response was abbreviated:

```bash
curl -sS $RUNWAY_BASE/api/v1/app/deploys/$DEPLOY_ID/scan \
  -H "Authorization: Bearer $RUNWAY_APP_KEY"
```

`$DEPLOY_ID` is in the blocked-deploy response. The full report
includes every finding even when the inline version was truncated.

## After fixing

Redeploy via `runway-deploy`. The scan re-runs on the new image; if
it passes the threshold, the new container replaces the old.
