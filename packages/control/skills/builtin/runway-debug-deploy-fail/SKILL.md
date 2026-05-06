---
name: runway-debug-deploy-fail
description: Use when a Runway deploy returned 5xx, the container exited unexpectedly, or the URL serves 502 / times out. Walks through the most common failure modes and how to confirm each one.
---

# Runway debug-deploy-fail

The deploy didn't end with a healthy running container. Work through
the checks below in order — most failures are one of the first three.

## 1. Read the build output

If the deploy returned HTTP 5xx, the response body still has
`log_tail`:

```json
{ "status": "failed", "log_tail": "...last 100 lines..." }
```

If you don't have it cached, fetch it from the deploy record:

```bash
curl -sS "$RUNWAY_BASE/api/v1/app/deploys?limit=1" \
  -H "Authorization: Bearer $RUNWAY_APP_KEY"
```

Common build-time fixes:
- **Missing file in tar** — usually `.dockerignore` excluded it
  too aggressively. Check that `Dockerfile` is at the upload root.
- **Lock file mismatch** — `pnpm install --frozen-lockfile` failed
  because `package.json` and the lock file disagree. Run the
  install locally and commit the updated lock file.
- **`npm run build` failed** — TS error, missing env var at build
  time, etc. Reproduce locally.

## 2. Check container status

If the build succeeded but the container exited:

```bash
curl -sS $RUNWAY_BASE/api/v1/app/status \
  -H "Authorization: Bearer $RUNWAY_APP_KEY"
```

`status` will be `exited` or `restarting`. `exit_code` tells you
why:

- **`exit_code: 1` + log says "EADDRINUSE" or "address already in
  use"** — port collision, shouldn't happen on Runway. Redeploy.
- **`exit_code: 137` (128+9)** — killed by OOM. The container
  exceeded its memory limit (default 512 MB). Either reduce the
  app's memory footprint or raise the limit via `/api/v1/app/configure`.
- **`exit_code: 139` (segfault)** — usually a native-module / glibc
  mismatch. Switching base image (e.g. `node:24-slim` → `node:24`)
  often fixes it.
- **Non-zero with no obvious crash** — fetch logs:

```bash
curl -sS "$RUNWAY_BASE/api/v1/app/logs?tail=200" \
  -H "Authorization: Bearer $RUNWAY_APP_KEY"
```

## 3. URL returns 502 but container is "running"

The container started but the gateway can't reach the app port.
Three likely causes:

- **Bound to `127.0.0.1` instead of `0.0.0.0`.** Inside a
  container, localhost-only sockets are unreachable from Traefik.
  Check the framework's bind config.
- **Wrong port.** The gateway routes to `3000` (or `80` for
  static). If your framework defaults to `8000`/`8080`/`5000`,
  override it. The port is fixed per runtime — Runway doesn't
  read `EXPOSE`.
- **App is still starting.** Some Python/Java apps take 10–30 s
  to boot. Wait, then retry.

Confirm with:

```bash
curl -k -i https://$DOMAIN
```

If the gateway returns 502 specifically (not 503 or 504), it's
**reaching** the container but the app isn't accepting on the
expected port.

## 4. Health check failing

If you configured a health check via `/api/v1/app/healthcheck` and
it fails 3× consecutively, Docker marks the container unhealthy.

- The health check **must** return `200` quickly without external
  dependencies.
- Don't proxy the health check to a database — if the DB blips,
  every container marks itself unhealthy and restart-loops.
- Use `/healthz` (or similar) returning a literal `200 OK`. Add
  deeper readiness probes only if needed.

## 5. TLS certificate error

The Let's Encrypt certificate is issued on the first HTTPS request,
which takes 5–15 s. If you `curl` immediately after deploy you
might see a cert error — that's expected, wait and retry. Use
`curl -k` to bypass cert verification while waiting.

## 6. Recently working, now broken

If the previous deploy was fine and only a small change broke it,
roll back while you fix:

```bash
curl -sS -X POST $RUNWAY_BASE/api/v1/app/rollback \
  -H "Authorization: Bearer $RUNWAY_APP_KEY"
```

This restores the previous image with the same env vars and
volumes. The site is back online while you debug locally.

## Escalation

If none of the above help, gather:
- The full `log_tail` from the failed deploy
- `/api/v1/app/status` output
- The last 200 lines from `/api/v1/app/logs`

…and surface them to the user along with what you've already
ruled out.
