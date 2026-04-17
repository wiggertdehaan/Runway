# CLAUDE.md

Notes for future Claude Code sessions working on **this repo** (the
Runway platform itself, not an app being deployed with Runway). Read
the README for a user-facing tour; this file is for the non-obvious
things that would waste time to re-derive.

## Repo layout at a glance

- `packages/control/` — Hono web app + REST API + deploy pipeline.
  - `src/routes/web.ts` — session-gated dashboard (htmx)
  - `src/routes/api.ts` — `/api/v1/*` (Bearer-token auth per app)
  - `src/routes/llms.ts` — unauthenticated `/llms.txt` for agents
  - `src/deploy/docker.ts` — dockerode wrapper (build, run, logs)
  - `src/deploy/gateway.ts` — writes Traefik file-provider YAMLs
  - `src/deploy/index.ts` — orchestrates a single deploy
  - `src/db/` — SQLite schema + helpers (uses `node:sqlite`, not
    better-sqlite3)
- `packages/mcp/` — optional MCP server for Claude Code.
  - `src/tools.ts` — zod-typed tool definitions
  - `src/tar.ts` — tars a project dir respecting dockerignore/gitignore
  - `src/client.ts` — HTTP client against the control API
- `docker-compose.yml` — Traefik + control, nothing else by default
- `install.sh` — bootstrap for a fresh Linux server

## Commands

```bash
pnpm install                 # once
pnpm typecheck               # must be clean before committing
pnpm --filter @runway/control dev   # run control locally on :3000
pnpm mcp:build               # build packages/mcp/dist for Claude Code
pnpm mcp:path                # print absolute path to the MCP entry
```

There is no test suite yet. Verification is `pnpm typecheck` plus a
round-trip on the dev server.

## Deploy-to-server flow (when editing the platform)

1. Make changes locally, run `pnpm typecheck`
2. Commit + push to `main` on GitHub
3. SSH to the Runway host, `cd /opt/runway`, `git pull`
4. `docker compose up -d --build` (or `--build control` if only the
   control image changed)
5. Check `docker logs runway-control` and `docker logs runway-gateway`

The user's actual server hostname and IP live in the memory index, not
here — this repo is public.

## Architecture decisions that already bit us

Each of these was the result of a real incident. Don't undo them
without knowing why.

### Node 24 everywhere
- Control uses `node:sqlite`, which is only stable on Node 24+.
- Dockerfile base is `node:24-slim`. `.nvmrc` and `package.json`
  engines are `>=24`.
- An earlier `node:22-slim` image caused runtime crashes.

### Traefik file provider, not docker provider
- Docker Engine 29.x raised its minimum API version; Traefik 3.5's
  bundled Moby client still negotiates 1.24 and gets rejected with
  `client version 1.24 is too old`.
- Using `tecnativa/docker-socket-proxy` in front does not help —
  it only does ACLs, not API version rewriting (verified).
- Current design: Traefik only reads YAML files from a shared
  `gateway-config` volume. The control plane writes:
  - `/config/dashboard.yml` on startup (from `DASHBOARD_DOMAIN`)
  - `/config/<app-id>.yml` on each deploy
- Traefik has **zero** Docker socket access. Do not reintroduce the
  docker provider.

### Builds run in isolated BuildKit, control still mounts the socket
- Image builds go to a separate BuildKit container, invoked via
  `docker exec` of `buildctl` inside that container (no TCP —
  control reaches buildkit through the Docker socket, not over the
  network). `RUN` steps in user Dockerfiles execute inside
  BuildKit's containerd sandbox with no Docker socket access.
- The control container still mounts `/var/run/docker.sock` for
  container lifecycle (run, stop, logs, stats).
- Running control as a non-root user requires matching the host's
  docker GID, which varies. Write access to the socket is already
  root-on-host, so running node as root inside the container does
  not widen the blast radius.

### Three Docker networks, not one
- `runway-internal` — control + gateway only.
- `runway-apps` — gateway + every deployed app container. Traefik
  straddles both networks so it can keep serving the dashboard and
  still route edge traffic to apps.
- `runway-build` — buildkit only. Isolates `RUN` steps from the
  control plane and other apps.
- An earlier topology put control, gateway, buildkit, and all apps
  on a single `runway-internal` network. That allowed a deployed
  container (or a malicious `RUN` step) to reach
  `http://control:3000/` and probe other app containers by name,
  bypassing Traefik entirely. Do not collapse the networks back
  into one.
- Existing app containers created before the split keep running on
  `runway-internal` until they are redeployed; a fresh deploy
  recreates the container on `runway-apps`. After upgrading the
  platform, redeploy each app once to complete the migration.
- Cloud metadata (`169.254.169.254` and friends) is still reachable
  from build sandboxes via the host network namespace — blocking
  it fully needs host iptables or custom CNI for buildkit. As a
  pragmatic defense, `packages/control/src/deploy/preflight.ts`
  scans the uploaded tar and rejects build contexts that reference
  well-known metadata hostnames/IPs. The optional host-level
  hardening is a single `iptables -I DOCKER-USER -d 169.254.169.254
  -j DROP` rule on the host.

### App IDs are lowercase
- Docker image names must be lowercase. The original nanoid
  alphabet included uppercase letters, which the daemon rejected on
  first deploy.
- `createApp()` uses `customAlphabet('0123456789abcdefghijklmnopqrstuvwxyz', 12)`.
- `deploy/index.ts` also has a `dockerSafeId()` helper that
  lowercases existing mixed-case ids for backwards compat.

### Port is derived from runtime, not hardcoded
- `static` → 80 (nginx), everything else → 3000.
- Set by `/api/v1/app/configure` via `defaultPortForRuntime()`.
- Earlier we hardcoded 3000 in the schema default, which caused a
  502 Bad Gateway on every static deploy (Traefik routed to :3000,
  nginx listened on :80).
- If a user needs a different port, they currently have to make
  their Dockerfile listen on the runtime's default.

### Dockerfile for control needs the workspace root
- `packages/control/tsconfig.json` extends `../../tsconfig.json`.
  The Docker build stage must `COPY tsconfig.json ./` or `tsc`
  fails with `TS5083: Cannot read file '/app/tsconfig.json'`.
- Build context is the repo root (`.`), not `packages/control/`.

### `ignore` package needs `createRequire`
- `import ignore from "ignore"` breaks under TS `Node16` module
  resolution. `packages/mcp/src/tar.ts` loads it via
  `createRequire(import.meta.url)` as a workaround — do not revert
  to a plain ESM import.

### Trivy security scan on every deploy
- `packages/control/src/deploy/scan.ts` shells out to a bundled
  Trivy binary (`COPY --from=aquasec/trivy:<version>` in
  `packages/control/Dockerfile`). Two scans run per deploy:
  `trivy fs --scanners secret,misconfig` on the extracted tar, and
  `trivy image --scanners vuln` on the built image after
  `loadImage()`.
- Findings are evaluated against the per-app `scan_threshold`
  (`none` / `low` / `medium` / `high` / `critical`, default `none`).
  On block, the new container is **not** started — the previously
  running container keeps serving. The `deploys` row is recorded
  with `status="blocked"` so the report stays inspectable.
- `node:24-slim` (bookworm-slim) ships **without** `ca-certificates`.
  Trivy is a Go binary and uses the system cert pool, so without the
  bundle it fails TLS when pulling its vulnerability DB from
  `mirror.gcr.io` with `x509: certificate signed by unknown authority`.
  The runtime stage of `packages/control/Dockerfile` installs
  `ca-certificates` — do not remove.
- The vuln DB (~500 MB) lives in a named `trivy-cache` volume
  mounted at `/root/.cache/trivy` (see `docker-compose.yml`). Trivy
  refreshes it every ~6 h; the system health page flags it red
  after 24 h.
- **Secret scanner whitelists known example keys.** The canonical
  AWS SDK sample `AKIAIOSFODNN7EXAMPLE` is explicitly ignored, so a
  test app using it will look like the scanner is broken when it
  isn't. Use realistic-looking random strings for negative tests.
- `runScans()` in `packages/control/src/deploy/index.ts` runs the
  source and image passes independently and merges findings +
  errors. A single leg failing produces `status="warned"` /
  `"blocked"` with an `error` message attached, not `"skipped"`.
  Only both legs failing with zero findings yields `"skipped"`.

### SSO (Google + Microsoft OAuth2)
- `packages/control/src/auth/oauth.ts` — provider configs, URL
  building, authorization code exchange, JWT payload decode. No
  external library; uses native `fetch()` for the token endpoint
  and manual base64url decode for the ID token (safe because we
  just exchanged the code over HTTPS directly with the provider).
- `packages/control/src/routes/oauth.ts` — mounted in `app.ts`
  before web routes. Contains:
  - `GET /auth/{google,microsoft}` — redirects to provider consent
  - `GET /auth/{google,microsoft}/callback` — exchanges code, looks
    up or auto-provisions a Runway user by email, creates session
  - `GET /auth/verify` — Traefik forward-auth endpoint, called on
    every request to SSO-protected app subdomains. Checks session
    cookie + email allowlist.
- `packages/control/src/db/app-emails.ts` — per-app email allowlist
  CRUD (add, remove, check, replace-all).
- **Session cookie domain**: when `base_domain` is configured, the
  session cookie is set on `.{base_domain}` (both in `web.ts` and
  `oauth.ts`) so it's readable by the forward-auth middleware on
  app subdomains. Custom domains are outside this cookie scope and
  therefore not SSO-protected.
- **Gateway**: `writeAppRoute()` emits a `forwardAuth` middleware
  when `ssoEnabled` is true. If the app also has a custom domain,
  two separate Traefik routers are generated: the subdomain router
  has forwardAuth, the custom-domain router does not.
- **SSO vs basic auth**: when both are enabled on an app, SSO takes
  precedence — the forwardAuth middleware replaces basicAuth.
- OAuth client credentials are stored in the settings table
  (`oauth_google_client_id`, `oauth_google_client_secret`,
  `oauth_microsoft_client_id`, `oauth_microsoft_client_secret`).

## Migrations

`packages/control/src/db/index.ts` runs `migrate()` on startup. It
is idempotent and includes an in-place rebuild of the `apps` table
for installations that predate the MCP-driven configure flow
(name/runtime used to be `NOT NULL`). Add new columns with
`ALTER TABLE ... ADD COLUMN` and bump the rebuild condition if you
change constraints.

## Conventions

- **Repo content is English.** Conversations with the user can be
  Dutch; code, comments, docs, commit messages, and UI strings are
  English.
- **Never commit personal data.** Domain names, IPs, emails, keys —
  nothing that is specific to the user's own deployment. Use
  `example.com` / placeholders in docs.
- **Commit style.** Imperative subject (< ~70 chars), wrapped body
  explaining *why*, ending with the `Co-Authored-By` trailer. Let
  `git commit` run hooks; do not `--no-verify`.
- **Don't add features beyond what was asked.** The roadmap items in
  the README aren't implicit tasks — scope is whatever the user
  requested in the current conversation.

## Two ways to talk to Runway

Both exist and both work; know when to use which:

1. **`/llms.txt`** — zero-install flow. Claude Code (or any agent)
   fetches the Markdown doc and uses `curl` + `tar` via its own
   shell tool. Primary flow; what `README.md` leads with.
2. **MCP server** — `packages/mcp/` shipped as a local process
   registered through `claude mcp add`. Stronger typing and fewer
   prompts, but requires build + registration. Alternative flow.

When you add a new capability to the control API, update **both**
`/llms.txt` (the Markdown body in `llms.ts`) and the MCP tools in
`packages/mcp/src/tools.ts` so the two surfaces stay in sync.
