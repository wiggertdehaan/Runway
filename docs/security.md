# Security

What Runway protects, how, and where its limits are. To report a vulnerability
see [SECURITY.md](../SECURITY.md).

- [The model in short](#the-model-in-short)
- [People and sessions](#people-and-sessions)
- [Tokens and the API](#tokens-and-the-api)
- [Rate limits](#rate-limits)
- [Audit log](#audit-log)
- [Uploads and builds](#uploads-and-builds)
- [Running apps](#running-apps)
- [The edge](#the-edge)
- [Scanning and actively exploited vulnerabilities](#scanning-and-actively-exploited-vulnerabilities)
- [Secrets](#secrets)
- [Known limits](#known-limits)
- [Hardening checklist](#hardening-checklist)

## The model in short

Runway is built for a small team on a server it owns, and for the case where
several people, each with their own apps, share one Runway. The actors it
distinguishes:

- **An admin** can do everything. Treat an admin account as root on the platform.
- **An app owner** (a member) manages their own apps only. They cannot see other
  people's apps, environment variables, scans or events.
- **A visitor to an app** is anonymous or, with SSO or basic auth on, checked at the
  gateway before the request reaches the app.
- **App code** is untrusted: it runs in a container with reduced rights on a
  network of its own.
- **Source you upload** is untrusted input: it is checked before it is unpacked and
  built in an isolated BuildKit container.
- **An agent** holds a token with a scope and an expiry, and sees what its person
  sees.

What an attacker would want: the Docker socket (it is root on the host), the secrets
and environment of apps, the database, the TLS certificates and the build cache.

## People and sessions

- Passwords are hashed with scrypt (`node:crypto`), salted per user, and compared in
  constant time. An unknown username still runs through the hash, so response time does
  not reveal whether an account exists.
- Sessions are random 32-byte tokens stored in SQLite with a 30-day lifetime. The
  cookie is `HttpOnly`, `Secure` and `SameSite=Lax`, and over HTTPS it is **host-only**
  with the `__Host-` prefix, so no subdomain can set or read it. Deployed apps never
  receive it. Apps behind SSO get their own cookie per host, see
  [Deploying apps](deploying-apps.md#single-sign-on).
- CSRF protection uses a double-submit cookie with timing-safe comparison on every
  POST form. The admin JSON API needs the header `X-Requested-With: runway` as well.
- Two-factor authentication (TOTP, ten single-use backup codes) is optional. Every
  guess, from the sign-in page and from every screen that asks for a code, is charged
  to the user in the database before the code is looked at: the 5th wrong code locks
  for a minute, then 5, 15 and 60 minutes, and a correct code is refused while a lock
  runs. A correct password does not reset the count. An admin can unlock on the Users
  page. A code can be used once.
- Sign-in attempts are limited to 5 failures per 15 minutes per address, kept in
  SQLite so a restart does not reset them.
- Google and Microsoft sign-in uses the authorization code flow with a random `state`
  cookie. It only signs in, links or creates an account for an address the provider
  says is verified, and creates accounts only for addresses or domains on the
  allowlist or with an open invitation. A redirect target must be a relative path or
  one of Runway's own hosts.
- The first account is created in the setup wizard, which asks for a one-time setup
  token until an admin exists.
- Apps belong to a user **id**, not a name, so renaming or deleting a user never hands
  their apps to someone else.

## Tokens and the API

- Per-app keys (`rwy_`), user tokens (`rwu_`) and skill tokens (`rwd_`) are shown once
  and stored only as a SHA-256 hash. An old backup from before hashing still holds
  plain keys, so protect or delete it.
- User tokens carry a scope (`read`, `deploy`, `admin`), expire (90 days by default,
  one year at most), are limited to 20 active per person and can be revoked by the
  person or by an admin. Their rights are decided on every request with the same
  functions the dashboard uses, and the `admin` scope needs the person to be an admin
  right now. A token cannot create tokens.
- An app key can be rotated with an optional overlap and is refused on routes that
  concern the whole account.
- Every route is gated by who is asking (`apiAuth`), then the rate limit, then the
  scope and the app they named, then the audit line. A route that is not explicitly a
  read needs the `deploy` scope, so a new route is never a free read.

## Rate limits

Limits are per key or token, not per address, so many people behind one office
address do not share an allowance. Each app key and each token gets its own buckets:
120 reads and 60 writes per minute, and 10 heavy actions (deploy, rollback, source
download) per 10 minutes. A refusal is HTTP 429 with `Retry-After`. Unknown keys are
counted per source address: 20 in 10 minutes blocks that address, even for a correct
key, until the window ends, and a missing header does not count. On top of that sits a
per-address flood guard of 600 requests per minute. The counters live in the memory
of the one control process, so a restart resets them. The variables are in
[Configuration](configuration.md#env-and-environment-variables).

## Audit log

Every admin action, sign-in, failed sign-in and 2FA lock is recorded with the
source address. Every change made through an app key or token (POST, PUT, PATCH,
DELETE, plus reading environment variables and source) is recorded by one middleware,
so a new route cannot forget it: who (`api-key:<app id>`, an MCP token or a user
token), which app, what, the result, and the **names** of the fields that changed,
never their values. Token-shaped strings are masked and control characters stripped.
Refused requests are counted in one line per source and ten minutes. API lines are
kept 90 days (at most 100,000), lines about people are never pruned.

## Uploads and builds

- The upload is streamed to disk with a hard size limit, not read into memory. The
  tar is checked entry by entry before anything is unpacked. It is refused when it is
  gzip or zstd, has an absolute path or `..`, a symlink or hard link that leaves the
  project, a device or fifo, too many entries, too long or too deep a path, or
  claims more data than the limit.
- Unpacking uses the `tar` library in the control process, with no shell, owned by an
  unprivileged user.
- Builds run in a separate **BuildKit** container on a network of its own. The `RUN`
  steps of a Dockerfile execute inside BuildKit's sandbox with no access to the Docker
  socket, to control or to other apps. The build cache is capped
  (`BUILDKIT_GC_KEEPSTORAGE`).
- Health check paths and volume mount paths are validated against strict character
  allowlists, so they cannot carry a command or a path traversal.
- Outbound requests Runway makes itself (the webhook, registry lookups, the KEV feed)
  go through an SSRF guard that re-checks the address just before the request.

## Running apps

- **One network per app.** Only Traefik is attached to several of them, so one app cannot
  reach another by container name and skip its SSO or basic auth. Control and BuildKit
  are on networks of their own.
- **What apps may reach outside Docker** (the cloud metadata address, the host itself,
  private ranges) is limited by an opt-in host firewall step, see
  [Operations](operations.md#limit-what-apps-can-reach-egress-rules). Without it, an app
  can still reach those addresses.
- **Hardened containers.** The default `standard` profile drops all Linux capabilities
  except six (`CHOWN`, `DAC_OVERRIDE`, `FOWNER`, `SETGID`, `SETUID`,
  `NET_BIND_SERVICE`), sets `no-new-privileges`, a limit of 512 processes, no swap and
  rotated logs. `strict` adds nothing back. `relaxed` is Docker's defaults. A read-only
  root filesystem is an opt-in per app. The code that starts an app container refuses
  privileged mode, host namespaces, devices, host-path mounts (including the Docker
  socket) and unknown capabilities.
- Memory and CPU limits apply to every app.
- A running container keeps what it started with: a new profile, or a new release of
  Runway, reaches an app at its next deploy, rebuild or rollback.

## The edge

- Traefik has no access to the Docker socket. Routing comes from YAML files control
  writes to a shared volume, and the Traefik dashboard and insecure API are off.
- TLS certificates come from Let's Encrypt over the HTTP-01 challenge.
- Every app route first removes any `X-Forwarded-User` header a visitor sent, and only
  forward-auth sets it. `/auth/verify` and `/maintenance` are for Traefik only: the
  dashboard host answers 404 for them, and a deny rule sits in front as a second lock.
- Pages carry a Content Security Policy. htmx is served from Runway itself, pinned, with a
  Subresource Integrity hash.

## Scanning and actively exploited vulnerabilities

Every deploy is scanned with Trivy for image CVEs, secrets in source and Dockerfile
misconfigurations, with a per-app blocking threshold. Running apps are rescanned daily.
Actively exploited CVEs (CISA KEV) start a countdown that ends in a quarantine, and
rebuilds go live only if they are not worse than what runs. Details are in
[Deploying apps](deploying-apps.md#security-scanning) and
[Operations](operations.md#kev-countdown-and-quarantine).

## Secrets

- Environment variables are stored in SQLite and injected when a container starts. They
  are visible to the app's owner, admins and holders of the app's key, so treat those as
  privileged. They are never written to the audit log or to events.
- OAuth client secrets sit in the settings table, in the same database as the password
  hashes, so the same trust boundary applies.
- The MCP client keeps tokens out of tool output, error messages and logs, and never
  sends a token to a server other than its own.
- Events carry a type, an app id and a fixed code, never logs, environment or error
  text. Text from an app is cut short, cleaned and marked as untrusted.

## Known limits

Be clear about what Runway does not do:

- **Control runs as root and holds the Docker socket.** That is how it starts and stops
  containers. A compromise of control is root on the host. Running control without root,
  or behind a socket proxy, is not done yet.
- **BuildKit runs privileged.** Builds are isolated from control and from apps by
  network and sandbox, but a container escape from a build step would reach the host.
  Anyone who may deploy can run code in a build step, so treat deploy rights as trusted.
- **The egress rules are opt-in** and cover IPv4 only.
- **The CSP still allows inline scripts and styles**, which the dashboard uses for its
  copy and reveal buttons.
- **ID tokens from Google and Microsoft are decoded, not signature-verified.** That is
  safe here because the token was just issued to Runway over a direct HTTPS code exchange
  with the provider.
- **An SSO app receives its own host's cookie** with every request (Traefik forwards
  cookies). It is worth nothing on any other host.
- **Rate limit counters are in memory**, per control process.
- **Event ids are global**, so gaps between the ids a caller sees are other apps' events.
  Nothing about their content leaks, only that something happened.

## Hardening checklist

- Keep the dashboard on HTTPS only and the setup token private. Make the first admin
  account straight after installing.
- Turn on 2FA for every admin.
- Fill the OAuth allowlist with a domain you control, never a public one such as
  `gmail.com`.
- Use user tokens with the smallest scope and a short expiry for agents and CI, and
  revoke the ones you no longer use.
- Apply the egress rules (`plan`, then `apply`) and test from an app container.
- Keep the server patched, and Runway itself (`git pull`, `docker compose pull`,
  `docker compose up -d --build`).
- Back up `scripts/backup-db.sh` output off the server and protect it like the live
  database.
