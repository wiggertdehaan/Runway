# Runway

> Deploy AI applications safely on your own server.

Runway is an open-source platform that makes it easy to run AI applications
on a self-hosted server (Hetzner, Hostinger, your own VPS). You install
Runway with one command, generate an API key in the dashboard, and hand
that key plus your Runway URL to Claude Code. Claude reads the API docs
directly from your Runway server and deploys your project as a Docker
container behind Traefik with a per-app Let's Encrypt certificate.

> **Status:** early work in progress. The control plane, the deploy
> pipeline (tarball upload → Docker build → run → Traefik routing), the
> LLM-agent discovery endpoint (`/llms.txt`), and the MCP server for
> Claude Code are all working end-to-end. Security scanning, an isolated
> builder service, login rate limiting, and CSRF tokens are still on the
> roadmap. Contributions welcome.

## How it works

```
Developer's machine                       Your server
┌──────────────────┐                     ┌─────────────────────────────┐
│  Claude Code     │  GET /llms.txt ───► │  Runway stack (Docker)      │
│                  │                     │  ├─ control (web UI + API)  │
│                  │  API key + URL ───► │  └─ gateway (Traefik + TLS) │
│                  │  tar upload   ───►  │                             │
│                  │                     │  Your app containers        │
└──────────────────┘                     │  └─ built by control        │
                                          └─────────────────────────────┘
```

1. Run the installer on your server. It installs Docker (if needed) and
   starts the Runway stack behind Traefik with automatic HTTPS.
2. Open the dashboard, create your admin account through the setup wizard,
   and configure your base (wildcard) domain (e.g. `runway.example.com`).
3. Click **Generate new API key** in the dashboard. The key is the only
   thing you need to copy — the app's name, runtime, and subdomain are
   set later, on first deploy.
4. Tell Claude Code *"deploy this project to `https://runway.example.com`,
   my key is `rwy_…`, the instructions are at
   `https://runway.example.com/llms.txt`"*. Claude fetches the
   instructions, asks you for a name and runtime if needed, and pushes
   your project as a Docker container.

## Requirements

- Linux server (Ubuntu, Debian, CentOS, RHEL, Fedora, Rocky, Alma)
- A domain name for the dashboard (e.g. `runway.example.com`) with a DNS
  A record pointing at the server
- A wildcard DNS record (`*.runway.example.com`) if you want apps to get
  automatic subdomains
- Ports 80 and 443 open to the public internet (for Let's Encrypt)

## Install

On a fresh server:

```bash
curl -fsSL https://raw.githubusercontent.com/wiggertdehaan/Runway/main/install.sh \
  | sudo DASHBOARD_DOMAIN=runway.example.com ACME_EMAIL=you@example.com bash
```

The installer will:

- Install Docker and Docker Compose (if missing)
- Configure the firewall (SSH, HTTP, HTTPS)
- Clone Runway to `/opt/runway`
- Write `/opt/runway/.env` with your dashboard domain and ACME email
- Start the stack with `docker compose up -d --build`
- Traefik requests a Let's Encrypt certificate on first access

Once it finishes, open `https://runway.example.com` in your browser. You'll
see the setup wizard where you create your first admin user and configure
the base (wildcard) domain for your apps.

## Deploying an app from Claude Code

There are two ways to connect Claude Code to Runway. Most users want the
first one.

### Option A — zero install (recommended)

Your Runway server exposes a Markdown document at `/llms.txt` that
describes its full API: authentication, configure flow, Dockerfile
conventions, tar upload, status, and logs, all with concrete `curl`
examples. Claude Code can fetch that document with its built-in
`WebFetch` tool and follow it using its `Bash` tool — no MCP server
to install, nothing to register.

1. Generate an API key in the dashboard (**Generate new API key**).
2. Open your project in a new Claude Code session. The project needs a
   `Dockerfile` in the root. If you don't have one, ask Claude to
   create one — `/llms.txt` contains minimal templates per runtime.
3. Tell Claude:

   > Deploy this project to `https://runway.example.com`. My key is
   > `rwy_...`. The instructions are at
   > `https://runway.example.com/llms.txt` — fetch them and follow
   > them.

Claude will fetch `/llms.txt`, walk through the steps, ask you for a
name and runtime the first time, and report the live URL when the
deploy succeeds.

### Option B — MCP server (structured tool calls)

For power users who deploy often and want deterministic tool calls
with schemas instead of free-form `curl`, Runway ships an MCP server
that wraps the same REST API.

**Build the MCP server once:**

```bash
git clone https://github.com/wiggertdehaan/Runway.git
cd Runway
pnpm install
pnpm mcp:build
pnpm mcp:path    # prints the absolute path to the built entry point
```

**Register it with Claude Code** from the project directory you want
to deploy:

```bash
claude mcp add runway \
  -s project \
  -e RUNWAY_URL=https://runway.example.com \
  -e RUNWAY_APP_KEY=rwy_... \
  -- node /absolute/path/to/Runway/packages/mcp/dist/index.js
```

On Windows the path looks like
`C:/Users/you/dev/Runway/packages/mcp/dist/index.js`. Use `pnpm mcp:path`
to print it.

**Open a new Claude Code session** in that project and say *"deploy
this to Runway"*. Claude calls `runway_get_config`, asks you for a
name and runtime if the app isn't configured yet, calls
`runway_configure`, then `runway_deploy` — which tars your working
directory (honoring `.dockerignore` and `.gitignore`), uploads it, and
the control plane builds and runs it behind Traefik with a per-app
Let's Encrypt certificate.

The MCP server also exposes `runway_status`, `runway_logs`,
`runway_package` (generate a Dockerfile), and `runway_preflight`.

## Repository layout

```
runway/
├── install.sh             # Bootstrap installer for a fresh Linux server
├── docker-compose.yml     # Traefik gateway + control plane stack
├── .env.example           # Reference env (DASHBOARD_DOMAIN, ACME_EMAIL)
├── packages/
│   ├── control/           # Web UI + REST API + deploy pipeline
│   │                      # (Hono + node:sqlite + dockerode)
│   │                      # Serves /llms.txt for LLM agents
│   └── mcp/               # Optional MCP server for Claude Code
└── LICENSE
```

On startup, the control container writes Traefik dynamic config
files for the dashboard and for each deployed app into a Docker
volume shared with the gateway. Traefik reads the directory and
picks up changes automatically, so there is no separate gateway
source directory.

## Tech stack

- **Language:** TypeScript across the board
- **Runtime:** Node.js 24 with the built-in `node:sqlite` module
- **Control plane:** [Hono](https://hono.dev/) + [htmx](https://htmx.org/),
  tarball deploys via [`dockerode`](https://github.com/apocas/dockerode)
- **Auth:** scrypt via `node:crypto`, session cookies in SQLite,
  HttpOnly + SameSite=Lax
- **Agent discovery:** plain Markdown served at `/llms.txt`
- **MCP server:** [`@modelcontextprotocol/sdk`](https://github.com/modelcontextprotocol/typescript-sdk)
- **Reverse proxy:** [Traefik](https://traefik.io/) with the file
  provider and Let's Encrypt HTTP-01 challenges

## Development

Requires Node.js 24+ and pnpm.

```bash
pnpm install
pnpm typecheck

cd packages/control
pnpm dev     # Starts the dashboard on http://localhost:3000
```

On first run, visit `http://localhost:3000` and the setup wizard will ask
you to create an admin account and (optionally) configure a base domain.

## Security notes

- **Passwords** are hashed with scrypt (via `node:crypto`), salted per user,
  and compared in constant time. Unknown usernames still run through the KDF
  to avoid leaking user existence via timing.
- **Sessions** are random 32-byte tokens stored in SQLite with a 30-day TTL.
  Cookies are `HttpOnly` and `SameSite=Lax`, which blocks cross-site POST CSRF
  on modern browsers. An explicit CSRF token is not yet implemented.
- **Login rate limiting** is not yet implemented — a brute-force attacker with
  direct network access could guess passwords. If you expose Runway publicly
  before this lands, enforce strong admin passwords or put it behind a VPN.
- **Traefik** is configured with the dashboard disabled. Do not add
  `--api.insecure=true` on a public server. Traefik does not have access
  to the Docker socket at all — routing is driven by YAML files in a
  shared volume managed by the control plane.
- The **control container** mounts `/var/run/docker.sock` so it can build
  images and launch containers via the Docker API. Write access to the
  Docker socket is effectively root on the host, so compromising the
  control plane compromises the host. Moving builds into an isolated
  builder container is on the roadmap.
- The **REST API** (`/api/v1/*`) uses Bearer-token auth with per-app keys,
  independent from the session cookie used by the web UI.
- The **deploy endpoint** accepts up to 100 MB of `application/x-tar` per
  request. The uploaded code is built as root inside Docker build, so
  treat API key holders as trusted.

## License

MIT — see [LICENSE](LICENSE).
