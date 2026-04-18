import { Hono } from "hono";

/**
 * Routes meant to be consumed by LLM agents. Unauthenticated —
 * the documents describe how to use the API but contain no secrets.
 * The client (e.g. Claude Code) will follow the instructions and
 * supply its own Bearer token on subsequent calls.
 */
export const llmsRoutes = new Hono();

// Dockerfile templates published in /llms.txt for agents that don't
// use the MCP server. These must stay aligned with the templates in
// packages/mcp/src/tools.ts (generateDockerfile) — both flows should
// produce a deploy that succeeds on the first try.
//
// Each template:
//  - upgrades OS packages right after FROM (silences scan vuln noise)
//  - drops to a non-root user before EXPOSE
//  - listens on the runtime's default port (3000 for node/python/go,
//    80 for static) — that's what the gateway routes to
const dockerfileTemplates = {
  node: `FROM node:24-slim AS base
RUN apt-get update && apt-get upgrade -y && rm -rf /var/lib/apt/lists/*
RUN corepack enable

FROM base AS deps
WORKDIR /app
COPY package.json pnpm-lock.yaml* package-lock.json* yarn.lock* ./
RUN if [ -f pnpm-lock.yaml ]; then pnpm install --frozen-lockfile; \\
    elif [ -f yarn.lock ]; then yarn install --frozen-lockfile; \\
    else npm ci; fi

FROM base AS build
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN npm run build --if-present

FROM base
WORKDIR /app
COPY --from=build /app .
RUN addgroup --system app && adduser --system --ingroup app app
USER app
EXPOSE 3000
CMD ["node", "."]`,

  python: `FROM python:3.12-slim
RUN apt-get update && apt-get upgrade -y && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt
COPY . .
RUN addgroup --system app && adduser --system --ingroup app app
USER app
EXPOSE 3000
CMD ["python", "main.py"]`,

  go: `FROM golang:1.23 AS build
WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
COPY . .
RUN CGO_ENABLED=0 go build -o /app/server ./...

FROM gcr.io/distroless/static-debian12
COPY --from=build /app/server /server
EXPOSE 3000
USER nonroot:nonroot
ENTRYPOINT ["/server"]`,

  static: `FROM nginx:1.27-alpine
RUN apk upgrade --no-cache \\
 && sed -i 's|pid.*nginx\\.pid;|pid /tmp/nginx.pid;|' /etc/nginx/nginx.conf \\
 && mkdir -p /var/cache/nginx/client_temp \\
              /var/cache/nginx/proxy_temp \\
              /var/cache/nginx/fastcgi_temp \\
              /var/cache/nginx/uwsgi_temp \\
              /var/cache/nginx/scgi_temp \\
 && chown -R nginx:nginx /var/cache/nginx /var/log/nginx /etc/nginx/conf.d
COPY --chown=nginx:nginx . /usr/share/nginx/html
USER nginx
EXPOSE 80`,
};

llmsRoutes.get("/llms.txt", (c) => {
  const base =
    process.env.DASHBOARD_DOMAIN
      ? `https://${process.env.DASHBOARD_DOMAIN}`
      : new URL(c.req.url).origin;

  const body = buildInstructions(base);
  return c.text(body, 200, {
    "content-type": "text/markdown; charset=utf-8",
    "cache-control": "public, max-age=60",
  });
});

function buildInstructions(base: string): string {
  return `# Runway

> Deploy a project as a containerized app on this Runway server.

This document is for LLM agents (Claude Code and similar) that have been
asked to deploy a project to ${base}. Follow the steps below using your
existing shell and HTTP tools — no MCP server or SDK is required.

You will be given an API key of the form \`rwy_...\`. Each key is tied to
one app on the server. Treat it as a secret and do not echo it to the user.

## Authentication

Every call below uses a Bearer token:

\`\`\`
Authorization: Bearer rwy_YOUR_KEY
\`\`\`

## Deploy flow

### 1. Inspect the current app state

\`\`\`bash
curl -sS ${base}/api/v1/app \\
  -H "Authorization: Bearer rwy_YOUR_KEY"
\`\`\`

The response is JSON with a \`configured\` boolean. If \`configured\` is
\`false\`, the app has only an API key and needs a name and runtime before
it can accept deploys.

### 2. Configure the app (only if not configured yet)

Ask the user for:

- **name** — a human-readable label, e.g. "My Bot". Runway derives a
  URL-safe slug from this to build the public subdomain.
- **runtime** — one of \`node\`, \`python\`, \`go\`, \`static\`.

Then:

\`\`\`bash
curl -sS -X POST ${base}/api/v1/app/configure \\
  -H "Authorization: Bearer rwy_YOUR_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{"name":"My Bot","runtime":"node"}'
\`\`\`

The response echoes the config and includes the computed \`domain\` (e.g.
\`my-bot.runway.example.com\`). Show that to the user so they know where
the app will live.

### 3. Ensure a Dockerfile exists

The deploy pipeline runs \`docker build\` on whatever you upload. The
project root must contain a \`Dockerfile\`. If there is no Dockerfile,
ask the user before creating one — and when you do, **copy one of the
templates below verbatim** rather than writing your own from scratch.
These templates are the same ones the Runway MCP server emits and have
been tested against the security scanner; ad-hoc Dockerfiles often
fail in subtle ways (wrong port, root user, missing OS upgrade,
broken non-root nginx pidfile) that cost an iteration to debug.

#### node (port 3000)

\`\`\`dockerfile
${dockerfileTemplates.node}
\`\`\`

#### python (port 3000)

\`\`\`dockerfile
${dockerfileTemplates.python}
\`\`\`

Replace \`main.py\` with your actual entrypoint. Your app must call
\`bind("0.0.0.0", 3000)\` (or framework equivalent) — binding to
\`127.0.0.1\` makes it unreachable from the gateway.

#### go (port 3000)

\`\`\`dockerfile
${dockerfileTemplates.go}
\`\`\`

The final image is distroless: no shell, no curl, no busybox. Anything
your binary needs (timezone data, CA bundle) must be in \`go build\`'s
output. Listen on \`0.0.0.0:3000\`.

#### static (port 80)

\`\`\`dockerfile
${dockerfileTemplates.static}
\`\`\`

The site root is the upload root: \`index.html\` must be at the top
level of the tar, not inside \`dist/\` or \`build/\`. If you have a build
step, run it first and tar the output directory's contents.

The \`sed\` line is **not optional** — it moves nginx's pidfile from
\`/run/nginx.pid\` (root-only) to \`/tmp/nginx.pid\` (writable by the
\`nginx\` user). Without it the container crash-loops with
\`open() "/run/nginx.pid" failed (13: Permission denied)\`.

#### Pitfalls that cost an iteration

These are the failure modes that show up most often on a first deploy:

- **Bind to \`0.0.0.0\`, not \`127.0.0.1\`.** Inside a container,
  localhost-only sockets are unreachable from the gateway. The deploy
  succeeds but the URL returns 502.
- **Port is fixed.** The gateway routes to 3000 (or 80 for static). If
  your framework defaults to a different port (8000, 8080, 5000),
  override it explicitly so it listens on the runtime's expected port.
- **Static: build before tar.** \`COPY . /usr/share/nginx/html\` copies
  the upload root. If your built site lives in \`dist/\`, either tar
  from inside \`dist/\` or change the COPY to \`COPY dist/ ...\`.
- **Don't iterate on \`scan.status: "warned"\`.** A warned deploy is
  live and serving — \`low\` and \`medium\` findings are advisory unless
  the user (or server admin) raises \`scan_threshold\`. Don't try to
  fix base-image CVEs reactively unless the user asks. Only \`blocked\`
  (HTTP 409) actually halts a deploy.
- **Tar from the project root,** the directory containing the
  Dockerfile. Tarring from one level up makes the Dockerfile invisible
  to the build.
- **\`.env\` is never deployed.** Set runtime config via
  \`/api/v1/app/env\` (see "Environment variables" below); it survives
  redeploys and never lands in the image. Adding \`.env\` to the tar
  also trips the secret scanner.

Each template already includes the OS package upgrade step (\`apt-get
upgrade\` or \`apk upgrade\`) right after \`FROM\`. Don't remove it —
that single step typically eliminates 5–20 base-image CVE warnings
that would otherwise show up in the scan report.

### 4. Respect .dockerignore / .gitignore

Before uploading, make sure large or sensitive paths are excluded:

- \`node_modules/\`, \`.git/\`, build artifacts, local databases
- \`.env\` files — secrets must never be shipped in the build context

Add or update \`.dockerignore\` as needed.

### 5. Upload the project as a tar stream

From the project root:

\`\`\`bash
tar --exclude-from=.dockerignore --exclude-from=.gitignore --exclude=.git -cf - . \\
  | curl -sS -X POST ${base}/api/v1/app/deploy \\
      -H "Authorization: Bearer rwy_YOUR_KEY" \\
      -H "Content-Type: application/x-tar" \\
      --data-binary @-
\`\`\`

Notes:

- The body must be a plain POSIX \`tar\` stream (not gzip).
- Maximum upload size is 100 MB. If you exceed this, tighten the
  ignore files.
- The request may take tens of seconds: the server builds the image
  and starts the container before returning.

On success the response is JSON like:

\`\`\`json
{
  "status": "deployed",
  "domain": "my-bot.runway.example.com",
  "container_id": "...",
  "image_tag": "runway-app-xxx:latest",
  "log_tail": "Step 6/6 : CMD ...\\nSuccessfully tagged ...",
  "scan": {
    "status": "passed",
    "counts": { "critical": 0, "high": 0, "medium": 0, "low": 0, "unknown": 0 },
    "findings": [],
    "truncated": false,
    "total_findings": 0
  }
}
\`\`\`

Tell the user the app is live at \`https://\${domain}\`.

If the scan produced findings, \`scan.status\` is \`warned\` (deploy still
went through) or \`blocked\` (deploy halted — see below). Each finding has
\`severity\`, \`source\` (\`image\`, \`secret\`, or \`misconfig\`), \`id\`,
and often \`pkg\`/\`version\`/\`fixedVersion\`. Summarize any \`CRITICAL\`
or \`HIGH\` findings for the user before moving on.

**Important:** the TLS certificate is issued on demand by Let's Encrypt
on the first HTTPS request. This takes 5–15 seconds. Wait before
verifying the URL — if you \`curl\` immediately you will get a
certificate error. Either wait 15 seconds, or use \`curl -k\` (ignore
cert) for the first check, or use the \`/app/status\` endpoint instead
(which does not go through TLS).

On failure (HTTP 5xx) the body still contains a \`log_tail\` with the
last lines of the build output — surface that to the user so they can
see why the build failed.

### 6. Check status and logs

\`\`\`bash
curl -sS ${base}/api/v1/app/status \\
  -H "Authorization: Bearer rwy_YOUR_KEY"

curl -sS "${base}/api/v1/app/logs?tail=200" \\
  -H "Authorization: Bearer rwy_YOUR_KEY"
\`\`\`

\`/status\` reports the container state (\`running\`, \`exited\`, etc.) and
the exit code. \`/logs\` returns the most recent stdout/stderr lines.

## Environment variables

Set environment variables **before** deploying so the container picks them
up on start. Variables are persisted on the server and injected on every
(re)deploy. Use this for secrets, database URLs, API keys — anything that
should not be baked into the image.

### Read current env vars

\`\`\`bash
curl -sS ${base}/api/v1/app/env \\
  -H "Authorization: Bearer rwy_YOUR_KEY"
\`\`\`

### Set or update env vars

Send a JSON object with an \`env\` key. Keys are merged — existing keys not
included in the request are left unchanged.

\`\`\`bash
curl -sS -X PUT ${base}/api/v1/app/env \\
  -H "Authorization: Bearer rwy_YOUR_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{"env":{"DATABASE_URL":"postgres://...","NODE_ENV":"production"}}'
\`\`\`

### Delete a single env var

\`\`\`bash
curl -sS -X DELETE ${base}/api/v1/app/env/DATABASE_URL \\
  -H "Authorization: Bearer rwy_YOUR_KEY"
\`\`\`

Env var names must match \`[A-Za-z_][A-Za-z0-9_]*\`.

After changing env vars, redeploy the app (step 5) so the container
restarts with the new values.

## Persistent volumes

Configure mount paths inside the container that should survive redeploys.
Each path is backed by a named Docker volume. Use this for databases,
file uploads, caches, or any data that must persist across container
rebuilds.

### Read current volumes

\`\`\`bash
curl -sS ${base}/api/v1/app/volumes \\
  -H "Authorization: Bearer rwy_YOUR_KEY"
\`\`\`

### Set volume mounts

Send the full list of absolute container paths. This **replaces** all
existing mounts — include every path you want.

\`\`\`bash
curl -sS -X PUT ${base}/api/v1/app/volumes \\
  -H "Authorization: Bearer rwy_YOUR_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{"mount_paths":["/app/data","/app/uploads"]}'
\`\`\`

### Delete a single volume mount

\`\`\`bash
curl -sS -X DELETE ${base}/api/v1/app/volumes/app/data \\
  -H "Authorization: Bearer rwy_YOUR_KEY"
\`\`\`

Configure volumes **before** deploying. Data written to these paths will
persist across redeploys. Removing a mount path from the config does
**not** delete the underlying Docker volume — the data is still
recoverable.

## Custom domain

By default each app gets a subdomain under the server's base domain.
You can also point a custom domain at the app. Before calling this
endpoint, have the user add a DNS record (CNAME to the base domain, or
A record to the server IP). Traefik will automatically issue a TLS
certificate via Let's Encrypt.

\`\`\`bash
curl -sS -X PUT ${base}/api/v1/app/domain \\
  -H "Authorization: Bearer rwy_YOUR_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{"custom_domain":"app.example.com"}'
\`\`\`

To remove the custom domain, pass \`null\`:

\`\`\`bash
curl -sS -X PUT ${base}/api/v1/app/domain \\
  -H "Authorization: Bearer rwy_YOUR_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{"custom_domain":null}'
\`\`\`

The custom domain takes effect immediately — Traefik updates its
routing configuration on the fly, no redeploy required.

## Health check

Configure an HTTP health check path so Docker monitors whether the app
is actually responding, not just whether the process is alive.

\`\`\`bash
curl -sS -X PUT ${base}/api/v1/app/healthcheck \\
  -H "Authorization: Bearer rwy_YOUR_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{"path":"/health"}'
\`\`\`

The container will be probed every 30 seconds. If three consecutive
checks fail, the container is marked unhealthy. Pass \`null\` to disable.
Takes effect on the next deploy.

## Security scan

Every deploy is scanned with [Trivy](https://trivy.dev) before the new
container is started. Three things are checked:

- **Image vulnerabilities** — OS packages and language dependencies in
  the built image, matched against the CVE database.
- **Secrets** — hardcoded keys or tokens in the uploaded source tree.
- **Dockerfile misconfigurations** — running as root, missing
  \`HEALTHCHECK\`, \`ADD\` with remote URLs, etc.

The scan result is returned inline in the deploy response under \`scan\`
and also stored per deploy on the server.

### Blocking behavior

Each app has a \`scan_threshold\`. The scan always runs; the threshold
only controls when a deploy is *halted*:

- \`none\` (default) — never block, just report findings.
- \`low\` / \`medium\` / \`high\` / \`critical\` — block the deploy if any
  finding meets or exceeds that severity.

When a deploy is blocked, the response is HTTP **409** with:

\`\`\`json
{
  "status": "blocked",
  "image_tag": "runway-app-xxx:latest",
  "deploy_id": 42,
  "scan": { "...": "..." },
  "hint": "Fix the findings, lower scan_threshold, or deploy again. ..."
}
\`\`\`

The existing container keeps running — nothing is replaced on block.
The built image is retained so you can inspect the full report:

\`\`\`bash
curl -sS ${base}/api/v1/app/deploys/42/scan \\
  -H "Authorization: Bearer rwy_YOUR_KEY"
\`\`\`

### Change the threshold

\`\`\`bash
curl -sS -X PUT ${base}/api/v1/app/scan-threshold \\
  -H "Authorization: Bearer rwy_YOUR_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{"threshold":"high"}'
\`\`\`

You can also pass \`scan_threshold\` in the \`/app/configure\` body.

### Server-wide scan floor

The server admin can set a minimum scan threshold that all apps must
respect. The \`/app\` config response includes \`effective_scan_threshold\`
which is the stricter of the per-app setting and the server floor. If
\`scan_floor_exempt\` is \`true\` on this app, only the per-app threshold
applies (admin granted an exemption).

### Read the latest scan

\`\`\`bash
curl -sS ${base}/api/v1/app/scan \\
  -H "Authorization: Bearer rwy_YOUR_KEY"
\`\`\`

## Basic auth

Put HTTP basic auth in front of the app at the gateway, useful for
password-protecting an internal tool without wiring up login in the
app itself. Only one username is supported per app.

### Enable (or rotate credentials)

\`\`\`bash
curl -sS -X PUT ${base}/api/v1/app/basic-auth \\
  -H "Authorization: Bearer rwy_YOUR_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{"enabled":true,"username":"alice","password":"correct horse battery staple"}'
\`\`\`

Takes effect immediately — Traefik reloads the route, no redeploy
required. Passwords are hashed (SHA1 \`{SHA}\` htpasswd format) before
they hit disk.

### Disable

\`\`\`bash
curl -sS -X PUT ${base}/api/v1/app/basic-auth \\
  -H "Authorization: Bearer rwy_YOUR_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{"enabled":false}'
\`\`\`

## SSO protection

Protect the app with Single Sign-On. Only users with emails in the
allowlist can access the app via the subdomain. Requires OAuth
providers configured on the server (Google and/or Microsoft).

### Read SSO status

\`\`\`bash
curl -sS ${base}/api/v1/app/sso \\
  -H "Authorization: Bearer rwy_YOUR_KEY"
\`\`\`

### Enable SSO and set allowlist

\`\`\`bash
curl -sS -X PUT ${base}/api/v1/app/sso \\
  -H "Authorization: Bearer rwy_YOUR_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{"enabled":true,"allowed_emails":["alice@example.com","bob@example.com"]}'
\`\`\`

### Disable SSO

\`\`\`bash
curl -sS -X PUT ${base}/api/v1/app/sso \\
  -H "Authorization: Bearer rwy_YOUR_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{"enabled":false}'
\`\`\`

SSO takes effect immediately via Traefik forward-auth on the
subdomain. When both SSO and basic auth are enabled, SSO takes
precedence. No redeploy required. Custom domain routes do not carry
the session cookie and are not SSO-protected.

## Deploy history & rollback

List recent deploys (most recent first) — useful to find a specific
historical version to roll back to:

\`\`\`bash
curl -sS "${base}/api/v1/app/deploys?limit=20" \\
  -H "Authorization: Bearer rwy_YOUR_KEY"
\`\`\`

Each entry has \`id\`, \`image_tag\`, \`status\` (\`success\`,
\`failed\`, \`blocked\`, \`warned\`), \`scan_status\`, \`scan_summary\`,
\`created_at\`, and \`is_current\`.

Roll back to the previous successful deploy:

\`\`\`bash
curl -sS -X POST ${base}/api/v1/app/rollback \\
  -H "Authorization: Bearer rwy_YOUR_KEY"
\`\`\`

Roll back to a specific historical deploy (find its \`id\` with
\`/app/deploys\`):

\`\`\`bash
curl -sS -X POST ${base}/api/v1/app/rollback \\
  -H "Authorization: Bearer rwy_YOUR_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{"deploy_id":42}'
\`\`\`

Rollback restarts the container with that image. Env vars, volumes,
and other configuration are preserved. Only successful deploys are
eligible; failed/blocked deploys never produced a runnable image.

## Error handling

- \`401 Unauthorized\` — the Bearer token is missing or invalid.
- \`409 Conflict\` on \`/app/deploy\` — the app has not been configured yet.
  Call \`/app/configure\` first.
- \`413 Payload Too Large\` — the tar exceeded 100 MB. Shrink the ignore
  lists.
- \`415 Unsupported Media Type\` — the Content-Type was not
  \`application/x-tar\`.
- \`500 Internal Server Error\` — the build or container start failed.
  Inspect \`log_tail\` in the response body.

## Conventions

- One Runway key = one app. If the user asks you to deploy a *different*
  project, ask them to generate a new key in the dashboard rather than
  reusing an existing one; otherwise you will overwrite the running
  container.
- Do not expose the API key in commit messages, git history, logs, or
  user-facing summaries.
`;
}
