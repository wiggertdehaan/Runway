# MCP and agents

Runway talks to coding agents three ways. They all use the same API and the same
rights; pick by how much setup you want.

| Way in | Needs | Good for |
|---|---|---|
| [`/llms.txt`](#zero-install-llmstxt) | nothing | one app, any agent that can run `curl` |
| [Skill server](#skill-server) | one `claude mcp add` | Claude Code, with deploy and debug skills |
| [Local MCP server](#local-mcp-server) | clone and build once | typed tools, one app or many apps on many Runways |

- [Tokens](#tokens)
- [Zero install: `/llms.txt`](#zero-install-llmstxt)
- [Skill server](#skill-server)
- [Local MCP server](#local-mcp-server)
- [One connection for several Runways](#one-connection-for-several-runways)
- [Tools](#tools)
- [Events](#events)
- [Telling your Runways apart](#telling-your-runways-apart)

## Tokens

Three kinds of secret, told apart by prefix. Each is shown once when it is made
and stored only as a hash.

| Prefix | Made on | Reaches | Notes |
|---|---|---|---|
| `rwy_` | the app page (**New app**) | one app, all of it | Rotate it on the **Access** tab with an optional overlap (1 hour, 24 hours or 7 days) so a pipeline can switch over. An admin or the app's owner can rotate. |
| `rwu_` | **Account, Access tokens** | every app you may see | Scope `read`, `deploy` or `admin`, an expiry (90 days by default, one year at most), at most 20 active per person. You or an admin can revoke it at any time. Works on `/api/v1` and `/mcp`. |
| `rwd_` | **Account, Skill MCP tokens** | the skill server, read-only | Expires, and can be revoked. |

A user token (`rwu_`) sees what you see on the dashboard: as an owner your own
apps, as an admin all of them. Rights are decided on every request, so a change
to your role or to an app's owner applies at once. The `admin` scope only works
while you are an admin. A token can never make tokens: that stays in the
dashboard.

| Scope | Lets the agent |
|---|---|
| `read` | list apps, read status, logs, scans and events |
| `deploy` | everything above, plus deploy, rebuild, rescan, configure, env, domain |
| `admin` | administrator actions |

Pick the smallest scope that does the job. API and MCP calls are rate limited
per token and every change they make is written to the audit log (field names,
never values). See [Security](security.md).

## Zero install: `/llms.txt`

Your Runway publishes its API documentation at `/llms.txt`: how to authenticate,
every endpoint, the pre-build guardrails and tested Dockerfile templates. Create
an app in the dashboard, copy the deploy instruction, paste it into Claude Code
(or any agent with a shell), and it deploys with `curl` and `tar`. No plugin,
no MCP server.

## Skill server

Runway hosts an MCP skill server next to the dashboard. Make a skill token on
**Account**, paste the one-line install command, and Claude Code picks up four
built-in skills:

- `runway-bootstrap`: set up a Runway-friendly project layout
- `runway-deploy`: push a deploy
- `runway-fix-scan-finding`: diagnose Trivy findings
- `runway-debug-deploy-fail`: diagnose failed deploys

```bash
claude mcp add runway-skills --transport http \
  https://runway.example.com/mcp \
  --header "Authorization: Bearer rwd_..."
```

The skills come straight from your Runway and stay current with it. Admins can
also import **curated** skills from public GitHub repositories (for example
`anthropics/skills/pdf`): Runway fetches the bundle, hashes it (SHA-256) and marks
it `signed` when the organisation is on the trusted-publisher list. Or paste your
own **custom** `SKILL.md` for house style and internal conventions. All three
layers are served over the same endpoint.

## Local MCP server

`packages/mcp` is an MCP server that runs on your machine and gives the agent
typed tools (deploy, env, volumes, scans, events) instead of `curl`.

```bash
git clone https://github.com/wiggertdehaan/Runway.git
cd Runway && pnpm install && pnpm mcp:build

claude mcp add runway \
  -s project \
  -e RUNWAY_URL=https://runway.example.com \
  -e RUNWAY_APP_KEY=rwy_... \
  -- node $(pnpm mcp:path)
```

Then say "deploy this to Runway" in any Claude Code session. This is the
per-app mode: the key is one app and it works exactly as it always has. For
several apps, or several Runways, use the next section.

## One connection for several Runways

For people who run more than one app, or more than one Runway server (a personal
one, a club one, a company one). The local MCP server reads a small config file,
holds one user token per server, and lets the agent choose the Runway and the app
on every call. The servers know nothing of each other: only your local process
bundles them, and every request carries only the token of the server it goes to.

**1. Make a token on each server.** Sign in, open **Account, Access tokens**, pick
a label, a scope and an expiry, and copy the `rwu_...` token. It is shown once.

**2. Write the config** to `~/.runway/config.json` (or point `RUNWAY_CONFIG` at
another file) and keep it private with `chmod 600`. The client warns if other
users can read it.

```json
{
  "runways": [
    { "name": "home",    "url": "https://runway.example.com", "token": "rwu_..." },
    { "name": "club",    "url": "https://apps.example.org",   "token_env": "RUNWAY_TOKEN_CLUB" },
    { "name": "company", "url": "https://runway.example.net", "token_env": "RUNWAY_TOKEN_COMPANY" }
  ]
}
```

- `name` is what you and the agent call the server (lowercase letters, digits, `-`, `_`).
- `token` is the token itself; `token_env` names an environment variable that
  holds it, so it need not be in the file.
- `url` must be `https://`. Plain `http://` is allowed only for `localhost`, or
  with `"allow_insecure": true` on a network you control.
- Optional `"app_keys": { "<app id>": "rwy_..." }` gives per-app keys for apps a
  token cannot reach. The key wins for that app.
- An unknown field is an error, so a typo cannot silently mean "no token".

With one server you can skip the file: `RUNWAY_URL` plus `RUNWAY_TOKEN` in the
environment works. With neither a file nor `RUNWAY_TOKEN`, the per-app mode above
is used, unchanged.

**3. Register it.** Build once (`pnpm install && pnpm mcp:build`), then:

```bash
# Claude Code
claude mcp add runway -s user -- node $(pnpm mcp:path)
```

```jsonc
// Claude Desktop: claude_desktop_config.json
// macOS:   ~/Library/Application Support/Claude/claude_desktop_config.json
// Windows: %APPDATA%\Claude\claude_desktop_config.json
{
  "mcpServers": {
    "runway": {
      "command": "node",   // use the full path to node if Desktop cannot find it
      "args": ["/path/to/Runway/packages/mcp/dist/index.js"],
      "env": { "RUNWAY_CONFIG": "/Users/you/.runway/config.json" }
    }
  }
}
```

Restart the client and ask "list my Runways". To add another Runway later, make a
token there, add an entry to the config, restart the connection and ask again.

**How it is used.** With a config, the app tools take two extra arguments:
`runway` (optional with one server; required, and never guessed, with several)
and `app` (needed with a user token; ids come from `runway_list_apps`).
`runway_list_runways` shows each server's name, address, whether it answers,
whether the token is valid, its scope and when it expires, never the token.
`runway_list_apps` lists your apps grouped by server, and one server being down
does not hide the others. `runway_events` asks every server at once and keeps one
cursor per server.

**What the client guarantees.** A token is only ever sent to its own server, and
a redirect is never followed, so it cannot be replayed elsewhere. It never
appears in tool output, error messages or logs. Every answer from a server is
rebuilt field by field before the model sees it, and text that came from an app
stays fenced as untrusted. A slow, failing or rate-limited server (HTTP 429) is
reported on its own and does not stop the others.

## Tools

The same tools exist in per-app mode and in multi-Runway mode. A few act on your
account and not on one app (`runway_list_apps`, `runway_create_app`,
`runway_rebuild`, `runway_rescan`): they need a user token (`rwu_`) and an app key
cannot use them.

- **Apps**: `runway_list_runways`, `runway_list_apps`, `runway_create_app`,
  `runway_configure`, `runway_get_config`, `runway_status`
- **Deploy**: `runway_package`, `runway_preflight`, `runway_deploy`,
  `runway_list_deploys`, `runway_rollback`, `runway_pull`, `runway_rebuild`
- **Run**: `runway_logs`, `runway_get_env`, `runway_set_env`, `runway_delete_env`,
  `runway_get_volumes`, `runway_set_volumes`, `runway_set_domain`,
  `runway_set_healthcheck`, `runway_set_basic_auth`, `runway_get_sso`,
  `runway_set_sso`
- **Security**: `runway_get_scan`, `runway_set_scan_threshold`, `runway_rescan`
- **Events**: `runway_events`, `runway_event_detail`

Rotating an app key is deliberately not an MCP tool: the new key would be shown
to the model. Do it in the dashboard.

## Events

`GET /api/v1/events?since=<cursor>` and the tools `runway_events` and
`runway_event_detail` tell an owner, or their agent, what happened to an app
without polling the dashboard: a deploy finished or failed, health changed, a
rebuild ended, an actively exploited vulnerability (KEV) deadline is near or the
app was quarantined, a dependency was updated or rolled back, a newer major
version is available, an exemption is ending.

An event is a type, an app id and a code from a fixed list. It never carries logs,
environment variables, error messages or text from the app. The caller keeps the
cursor and asks again (it is a pull, so it works in every client). A user token
sees exactly the apps that person may see. A cursor older than the retention
returns `cursor_expired` with the events that remain. Details of one event come
from `GET /api/v1/events/:id`, and any text an app contributed (a package name,
say) is cut to 200 characters, stripped of control characters and returned in an
`untrusted_text` field that clients treat as data, never as instructions.

Events are kept for 60 days and at most 500 per app (`EVENTS_RETENTION_DAYS`,
`EVENTS_MAX_PER_APP`). The full list of codes is in `/llms.txt`.

## Telling your Runways apart

An admin can give each server a colour and a short name under **Settings,
Instance identity**. The colour fills the logo square and the browser-tab icon and
the name shows next to "Runway", in the page title and on the login page, so you
see which server you are on, also before signing in. `runway_list_runways` shows
both as `instance`. It is a label: nothing is routed or decided on it. The public
`/instance.json` contains exactly those two fields.
