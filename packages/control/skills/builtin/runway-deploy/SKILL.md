---
name: runway-deploy
description: Use when the project is ready to ship to Runway. Configures the app, uploads the build context as a tar stream, and reports the live URL plus any scan findings.
---

# Runway deploy

The user has a Runway server and an API key (`rwy_...`) tied to one
app. This skill walks you through configuring that app (if needed)
and pushing the first or next deploy.

If you don't yet have a Dockerfile or `.dockerignore`, run the
`runway-bootstrap` skill first.

## 1. Inspect current state

The user knows the Runway base URL (e.g. `https://runway.example.com`).
Resolve `RUNWAY_BASE` from the user, then:

```bash
curl -sS $RUNWAY_BASE/api/v1/app \
  -H "Authorization: Bearer $RUNWAY_APP_KEY"
```

Returned JSON has a `configured` boolean. If `false`, the app needs
a name and runtime first.

## 2. Configure (only if not configured)

Ask the user for:
- **name** — human-readable label, e.g. "My Bot". Runway derives a
  URL-safe slug from this for the public subdomain.
- **runtime** — one of `node`, `python`, `go`, `static`.

```bash
curl -sS -X POST $RUNWAY_BASE/api/v1/app/configure \
  -H "Authorization: Bearer $RUNWAY_APP_KEY" \
  -H "Content-Type: application/json" \
  -d '{"name":"My Bot","runtime":"node"}'
```

The response includes the computed `domain`. Show it to the user.

## 3. Set environment variables before deploying

Variables are persisted on the server and injected on every deploy.
Use this for secrets, DB URLs, API keys — never bake them into the
image.

```bash
curl -sS -X PUT $RUNWAY_BASE/api/v1/app/env \
  -H "Authorization: Bearer $RUNWAY_APP_KEY" \
  -H "Content-Type: application/json" \
  -d '{"env":{"DATABASE_URL":"...","NODE_ENV":"production"}}'
```

Keys must match `[A-Za-z_][A-Za-z0-9_]*`. Existing keys not in the
request are left untouched.

## 4. Tar and upload

From the project root (the directory containing the Dockerfile):

```bash
tar --exclude-from=.dockerignore --exclude-from=.gitignore --exclude=.git -cf - . \
  | curl -sS -X POST $RUNWAY_BASE/api/v1/app/deploy \
      -H "Authorization: Bearer $RUNWAY_APP_KEY" \
      -H "Content-Type: application/x-tar" \
      --data-binary @-
```

Constraints:
- Body must be plain POSIX `tar` (not gzip).
- Max upload 100 MB by default (admin-configurable in Settings).
- The request can take tens of seconds — the server builds and
  starts the container before responding.

## 5. Read the response

On success:

```json
{
  "status": "deployed",
  "domain": "my-bot.runway.example.com",
  "image_tag": "runway-app-xxx:latest",
  "scan": {
    "status": "passed",
    "counts": { "critical": 0, "high": 0, "medium": 0, "low": 0 },
    "findings": []
  }
}
```

Tell the user the app is live at `https://${domain}`.

**Wait 5–15 seconds before verifying the URL** — the TLS certificate
is issued on first HTTPS request. Either wait, use `curl -k`, or hit
`/api/v1/app/status` (which doesn't go through TLS).

If `scan.status === "warned"`, the deploy went through but findings
were reported. **Do not iterate on warnings unless the user asks** —
`low`/`medium` are advisory. Only `blocked` (HTTP 409) halts the
deploy.

If `scan.status === "blocked"` or HTTP 409, the build succeeded but
the new container was not started — the previous version keeps
serving. Use the `runway-fix-scan-finding` skill to triage.

If HTTP 5xx: the body still has `log_tail` with the last build
output lines. Surface that to the user. Use the
`runway-debug-deploy-fail` skill if it's not obvious.

## 6. Post-deploy

To check status or logs:

```bash
curl -sS $RUNWAY_BASE/api/v1/app/status \
  -H "Authorization: Bearer $RUNWAY_APP_KEY"

curl -sS "$RUNWAY_BASE/api/v1/app/logs?tail=200" \
  -H "Authorization: Bearer $RUNWAY_APP_KEY"
```

## Tips

- One Runway key = one app. If the user wants to deploy a different
  project, they need a new key from the dashboard. Reusing one
  overwrites the running container.
- Never expose the API key in commit messages, git history, or
  user-facing summaries.
- If the tarball is unexpectedly large, GNU `tar`'s
  `--exclude-from=.dockerignore` doesn't fully match Docker's
  parser (bare `out/` matches anywhere under Docker, only at the
  tar root under GNU tar). Add explicit `--exclude='**/out'` flags
  if needed.
