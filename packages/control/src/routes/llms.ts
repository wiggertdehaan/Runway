import { Hono } from "hono";

/**
 * Routes meant to be consumed by LLM agents. Unauthenticated —
 * the documents describe how to use the API but contain no secrets.
 * The client (e.g. Claude Code) will follow the instructions and
 * supply its own Bearer token on subsequent calls.
 */
export const llmsRoutes = new Hono();

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
project root must contain a \`Dockerfile\`. If there is no Dockerfile, ask
the user before creating one. A minimal template for each supported
runtime:

- **node**: \`FROM node:24-slim\`, copy package.json + source, \`npm ci\` (or
  \`pnpm install --frozen-lockfile\`), run \`npm run build\` if a build script
  exists, \`EXPOSE 3000\`, \`CMD ["node", "."]\`.
- **python**: \`FROM python:3.12-slim\`, copy requirements.txt + source,
  \`pip install -r requirements.txt\`, \`EXPOSE 3000\`, \`CMD ["python","main.py"]\`.
- **go**: multi-stage build from \`golang:1.23\` to \`gcr.io/distroless/static-debian12\`.
- **static**: \`FROM nginx:1.27-alpine\`, \`COPY . /usr/share/nginx/html\`, \`EXPOSE 80\`.

The app is expected to listen on port 3000 unless the runtime is
\`static\` (port 80). That port is already configured on the server; do
not try to change it.

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
  "log_tail": "Step 6/6 : CMD ...\\nSuccessfully tagged ..."
}
\`\`\`

Tell the user the app is live at \`https://\${domain}\`. The certificate
is issued on demand by Let's Encrypt and may take a few seconds to
arrive on the first request.

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
