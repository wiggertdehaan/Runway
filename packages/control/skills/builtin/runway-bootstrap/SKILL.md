---
name: runway-bootstrap
description: Use when starting a new project that will be deployed to Runway. Sets up a Dockerfile, .dockerignore, health check, and project layout that passes Runway's security scan on the first deploy.
---

# Runway bootstrap

Use this skill before writing the application code. It establishes
the Runway-friendly defaults that prevent the most common
first-deploy failures (Trivy CVE blocks, port mismatches, root
containers, leaked secrets).

## Day-one rules

- **Pin everything.** No `:latest` base images, no unpinned
  dependencies. Commit lock files (`pnpm-lock.yaml`,
  `requirements.txt`, `go.sum`).
- **Run as non-root.** Drop to a dedicated user before `EXPOSE`.
  Persistent volumes only mount with correct ownership when the
  container is non-root from the start.
- **Plan a health check** at `/healthz` returning a plain `200` and
  no external dependencies. Wire it on day one — Runway probes it
  every 30 s once configured.
- **No secrets in image or repo.** All runtime config goes through
  Runway env vars (`/api/v1/app/env`); never bake them into the
  Dockerfile or commit them to source.
- **`.dockerignore` from the start.** Add `node_modules/`, `.git/`,
  build artifacts, local databases, and `.env*` *before* the first
  tar.
- **Multi-stage builds.** Smaller attack surface, fewer base-image
  CVEs in the final image, faster Trivy scans.
- **Bind to `0.0.0.0`, not `127.0.0.1`.** Default port is `3000`
  (`80` for static). Localhost-only sockets are unreachable from the
  gateway.

## Per-runtime checklist

### Node
- No `eval` / `Function(...)` on user input.
- Prepared statements / parameterized queries — never string concat
  for SQL.
- Set security headers via `helmet`.
- Validate inputs at request boundaries (`zod` or JSON schema).

### Python
- Parameterized queries everywhere.
- `pydantic` at input boundaries.
- Never `pickle` untrusted data.
- Use `secrets` (not `random`) for tokens.

### Go
- `database/sql` with parameter placeholders.
- `html/template` (not `text/template`) for any HTML output.
- Context deadlines on every handler.

### Static
- Set a CSP header in nginx.
- No secrets in the JS bundle.
- SRI on external scripts.
- No inline event handlers.

## Dockerfile templates

Copy one of these verbatim. They're tested against Runway's scanner
and security gate. Each one:
- Pins the base image
- Runs `apt-get upgrade` (or `apk upgrade`) right after `FROM`
- Drops to a non-root user before `EXPOSE`

### Node (port 3000)

```dockerfile
FROM node:24-slim AS base
RUN apt-get update && apt-get upgrade -y && rm -rf /var/lib/apt/lists/*
RUN corepack enable

FROM base AS deps
WORKDIR /app
COPY package.json pnpm-lock.yaml* package-lock.json* yarn.lock* ./
RUN if [ -f pnpm-lock.yaml ]; then pnpm install --frozen-lockfile; \
    elif [ -f yarn.lock ]; then yarn install --frozen-lockfile; \
    else npm ci; fi

FROM base AS build
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN npm run build --if-present

FROM base
WORKDIR /app
COPY --from=build /app .
# The npm bundled in node:24-slim ships HIGH-severity CVEs in tar,
# minimatch, cross-spawn, etc. We don't need it at runtime, so wipe
# it before the scan runs.
RUN rm -rf /usr/local/lib/node_modules/npm /usr/local/bin/npm /usr/local/bin/npx \
 && addgroup --system app && adduser --system --ingroup app app
USER app
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "require('http').get('http://127.0.0.1:3000/healthz', r => process.exit(r.statusCode < 500 ? 0 : 1)).on('error', () => process.exit(1))"
CMD ["node", "."]
```

### Python (port 3000)

```dockerfile
FROM python:3.12-slim
RUN apt-get update && apt-get upgrade -y && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt
COPY . .
RUN addgroup --system app && adduser --system --ingroup app app
USER app
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD python -c "import urllib.request,sys; r=urllib.request.urlopen('http://127.0.0.1:3000/healthz',timeout=3); sys.exit(0 if r.status<500 else 1)"
CMD ["python", "main.py"]
```

If your app's `effective_scan_threshold` is `high` or stricter,
prefer the Alpine variant — Debian `slim` ships with
HIGH-severity OS package CVEs that `apt-get upgrade` cannot remove:

```dockerfile
FROM python:3.12-alpine AS builder
WORKDIR /build
RUN apk add --no-cache build-base linux-headers libffi-dev
COPY requirements.txt ./
RUN pip install --no-cache-dir --target=/install -r requirements.txt

FROM python:3.12-alpine
RUN apk upgrade --no-cache && adduser -D -u 1001 app
WORKDIR /app
COPY --from=builder /install /app/lib
COPY . .
ENV PYTHONPATH=/app/lib PYTHONUNBUFFERED=1
USER app
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD python -c "import urllib.request,sys; r=urllib.request.urlopen('http://127.0.0.1:3000/healthz',timeout=3); sys.exit(0 if r.status<500 else 1)"
CMD ["python", "main.py"]
```

### Go (port 3000)

```dockerfile
FROM golang:1.23 AS build
WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
COPY . .
RUN CGO_ENABLED=0 go build -o /app/server ./...

# distroless/static has no shell and cannot run HEALTHCHECK CMD.
# Trivy DS026 (LOW) will flag the missing instruction; if you target
# scan_threshold=low either build a healthcheck flag into the binary
# or switch to gcr.io/distroless/static-debian12:debug (adds busybox).
FROM gcr.io/distroless/static-debian12
COPY --from=build /app/server /server
EXPOSE 3000
USER nonroot:nonroot
ENTRYPOINT ["/server"]
```

The final image is distroless: no shell, no curl. Anything the
binary needs (timezone data, CA bundle) must be in the `go build`
output.

### Static (port 80)

```dockerfile
FROM nginx:1.27-alpine
RUN apk upgrade --no-cache \
 && sed -i 's|pid.*nginx\.pid;|pid /tmp/nginx.pid;|' /etc/nginx/nginx.conf \
 && mkdir -p /var/cache/nginx/client_temp \
              /var/cache/nginx/proxy_temp \
              /var/cache/nginx/fastcgi_temp \
              /var/cache/nginx/uwsgi_temp \
              /var/cache/nginx/scgi_temp \
 && chown -R nginx:nginx /var/cache/nginx /var/log/nginx /etc/nginx/conf.d
COPY --chown=nginx:nginx . /usr/share/nginx/html
USER nginx
EXPOSE 80
HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
  CMD wget --quiet --tries=1 --spider http://127.0.0.1:80/ || exit 1
```

The `sed` line is **not optional** — it moves nginx's pidfile to a
non-root-writable path. Without it the container crash-loops on
`open() "/run/nginx.pid" failed (13: Permission denied)`.

## Persistent volumes

If the app uses volumes, `mkdir` and `chown` each mount path
**inside the Dockerfile** before the `USER` directive. Docker
creates volume mount points owned by `root` on first start; without
this step a non-root container can't write to them and crashes:

```dockerfile
RUN addgroup --system app && adduser --system --ingroup app app \
 && mkdir -p /app/data /app/uploads \
 && chown -R app:app /app/data /app/uploads
USER app
```

## Next step

When the project layout is in place, switch to the `runway-deploy`
skill to ship the first deploy.
