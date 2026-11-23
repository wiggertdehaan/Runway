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
  - `src/config.ts`, `src/registry.ts`, `src/multi.ts` — several Runway
    servers (see "One MCP connection, several Runways")
- `docker-compose.yml` — Traefik + control, nothing else by default
- `install.sh` — bootstrap for a fresh Linux server

## Commands

```bash
pnpm install                 # once
pnpm typecheck               # must be clean before committing
pnpm test                    # vitest, control package only (no
                             #   integration / DB / HTTP tests yet)
pnpm --filter @runway/control dev   # run control locally on :3000
pnpm mcp:build               # build packages/mcp/dist for Claude Code
pnpm mcp:path                # print absolute path to the MCP entry
```

The test suite (vitest, in `packages/control/src/**/*.test.ts`) only
covers pure functions: source parsers, hashers, validators,
formatters, the SSRF allowlist, and the scan-threshold logic. No
HTTP, DB, or network integration tests yet — those rely on the dev
server round-trip. When you add a new pure helper, add the test
beside it (`foo.ts` → `foo.test.ts`).

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

### Docker networks: one per app, plus internal and build
- `runway-internal` — control + gateway only.
- `runway-net-<id>` — one per app (S04), created by `deploy/networks.ts` in
  `runContainer`. It holds the app and the gateway, nothing else. Traefik
  straddles all of them (attached at runtime through the Docker API), so an app
  cannot reach another app by container name and skip its SSO/basic auth.
  Subnets come from our own pool (`RUNWAY_APP_NET_POOL`, default
  `10.250.0.0/16`, `/28` slices): Docker's default pools give a /16 per network
  and run out after ~30 networks. The bridge interface is named `rwa-<11 hex>`
  so the host firewall can match `-i rwa+` once and also cover networks created
  later. Keep that prefix and the 15-character limit.
- Recreating the gateway container (`docker compose up`) drops every network
  that was attached at runtime. `startGatewayNetworkReconciler` reattaches the
  gateway at startup and every minute and removes the network of a deleted app
  once only the gateway is on it. Do not remove it: without it every route
  answers 502 after a gateway recreate until someone redeploys.
- `runContainer` fails the deploy when the network cannot be made or the
  gateway cannot be attached. It must not fall back to the shared network (that
  silently undoes the isolation). `RUNWAY_APP_NETWORK_MODE=shared` is the
  deliberate, explicit way back.
- `runway-apps` — the shared network every app used before 0.39. Apps that have
  not been redeployed since the upgrade are still on it (they can reach each
  other until they move; control logs how many). It stays in the compose file
  until none is left.
- `runway-build` — buildkit only. Isolates `RUN` steps from the control plane
  and other apps.
- An earlier topology put control, gateway, buildkit, and all apps on a single
  `runway-internal` network, which let a deployed container (or a malicious
  `RUN` step) reach `http://control:3000/`. Do not collapse the networks.
- What apps and build steps may reach *outside* Docker is a host firewall
  matter, not something the compose file can do: `scripts/egress-rules.sh`
  (opt-in, `plan`/`apply`/`status`/`remove`/`persist`) refuses traffic from the
  app and build bridges to link-local (cloud metadata), RFC1918 and
  100.64.0.0/10, and anything they send to the host itself, while leaving the
  internet alone. It only ever matches those interfaces, so SSH and the rest of
  the host are unaffected. The tar scan in `deploy/preflight.ts` is a warning
  layer on top; a decimal/hex address or a DNS name gets past it.

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

### Rebuild-all (cache-free, health-verified)
- `deploy/rebuild.ts` rebuilds from the stored source tar
  (`latestSource`) via `deployApp({ noCache, verifyHealth,
  skipSourceSave })`. `noCache` adds `buildctl --no-cache`;
  `verifyHealth` waits (`deploy/health.ts`) and, if the new container
  is not healthy, recreates the previous image tag and throws
  `UnhealthyDeployError`. Regular deploys are unchanged (no wait).
- `rebuildApp` never throws; every failure is an outcome so a batch
  continues. Runs are strictly sequential and one at a time
  (`startRebuildRun` throws `RebuildBusyError`). Progress lives in
  `rebuild_runs.results` (JSON, rewritten per app).
- KEV data is the CISA feed (`deploy/kev.ts`, cached 24h next to the
  DB). Trivy's JSON has no KEV flag, so matching is by CVE id.
- Weekly job: `deploy/rebuild-scheduler.ts`, 1-minute tick against
  Europe/Amsterdam wall-clock; last launch date is persisted in
  settings (`auto_rebuild_last_date`). Per-app opt-out:
  `apps.auto_rebuild`.
- Base-image auto-patch (`deploy/base-images.ts`, pure; registry
  access in `deploy/registry.ts`, SSRF-guarded): rebuilds plan bumps of
  exact patch pins (same major.minor + same variant only) and apply them
  to a build-time Dockerfile copy (`dockerfileOverride`) or via
  `--build-arg` for ARG-driven FROMs; the stored source tar is never
  touched. Tags from a registry are charset-validated before they are
  written anywhere. Gotcha: BuildKit's incremental context sync compares
  size+mtime; the override is written with a fresh mtime for that
  reason.
- Minor escalation (`deploy/escalation.ts`, pure helpers in
  `base-images.ts` + `gate.ts`): after the patch stage went live, targets =
  KEV or CRITICAL-with-fix still in the scan. Candidates = newest patch of
  each higher minor (same major + variant + pin style), lowest first, max
  3; each is a real `deployApp` whose gate = not-worse AND resolves ALL
  targets (blocked candidates are recorded as `blocked` deploys, visible in
  history). Unhealthy/failed halts everything (also the major probe). Only
  the runtime stage's base is retargeted (`findRuntimeFrom`, follows
  `FROM <stage>` chains). Majors are never deployed: `dryRun` build+scan
  only, then an owner notice (deduped 7 days).
- Dependency auto-update (`deploy/dep-updates.ts` pure, `dep-apply.ts`
  I/O, `dep-stage.ts` one attempt; per-app `apps.auto_update_deps`,
  default on). Targets = KEV / CRITICAL / HIGH with a fix in the app's own
  Python or Node packages (`Finding.pkgType` / `pkgPath`; npm's bundled
  modules under `lib/node_modules` are not the app's). Compatible updates
  (same major; 0.x: same minor) are folded into stage 1 as one build; if
  that build does not go live the plain rebuild runs as before. Majors
  follow, one package per build, max 3 per rebuild, but only when
  `apps.auto_update_deps_major` is on (default 0, also for existing apps;
  `withholdMajors` reports them as skipped "major available" steps). Gate =
  `evaluateDepGate` (not worse AND, for one package, all its findings
  gone; for a batch, at least one gone, with the rest reported per package
  as `ineffective`), plus healthcheck with restore. A batch that does not
  go live is retried one package at a time (max 3) so one bad package
  cannot hold the others back. This is the ONE place a rebuild changes the
  source: the patched tar is saved as that deploy's snapshot
  (`skipSourceSave: false`) so a pull returns the fixed manifests; the
  uploaded source stays in the earlier snapshot (retention 10; a legacy
  `<id>.tar` is first saved under the running deploy's id, because it is
  unreachable once a per-deploy snapshot exists). Failed
  versions are remembered in `dep_update_attempts` and skipped for 14 days
  by scheduled runs (a manual rebuild retries). Three rules that must
  stay: (1) the tar is never unpacked as a tree, a manifest is read with
  `tar -xO` and replaced as a single member, and only regular-file members
  are touched (control is root; no writes through links), member names
  are data (`safeMemberName` + `--` before every name: a name starting
  with `-` is otherwise a tar option, and `--to-command` runs a program); (2) npm never
  runs in the control container: `package-lock.json` is regenerated by a
  throwaway BuildKit build of just the manifests (`lockSyncViaBuildKit`,
  `--ignore-scripts`) and lifted out with `readFileFromImage`; (3) escalation
  and later stages must build from the patched tar (`liveTar`), or they
  silently redeploy the unpatched source. Not handled yet: yarn / pnpm /
  bun lockfiles, pyproject, Pipfile, hash-pinned requirements, manifests
  below the top level for Node.
- Quarantine (`deploy/quarantine.ts`): `decideQuarantine` is a pure state
  machine (grace -> final rebuild attempt -> quarantined; resolve/lift);
  per-KEV first-seen clocks live in `app_quarantine.kev_first_seen`. The
  1-minute tick only reads DB + the cached KEV list; it judges the latest
  periodic scan of the CURRENT image_tag (every successful deploy stores
  its scan as that baseline) and does nothing without KEV data. Quarantine
  = `stopContainerByName` (keeps container+volumes) + maintenance route
  (replacePath to control's public `/maintenance`, 503). Rebuilding a
  quarantined app uses `keepOffline` (never fall back to the old image on
  unhealthy) and `requireKevFree`.
- Rebuild gate (`evaluateRebuildGate`) REPLACES the scan-threshold gate
  for rebuilds only (`deployApp({ scanGate })`): live iff no new
  CRITICAL and no new KEV vs a fresh scan of the running image, plus
  health. Fails closed without a baseline or when the new scan is
  skipped. Plain deploys keep the threshold gate.
- Used base images come from the BuildKit log (`] FROM ref@sha256:`),
  not from the Dockerfile, so they are what was really resolved;
  stored in `deploys.base_images`.
- The admin JSON API is under `/admin/api/*` (session + admin +
  `X-Requested-With: runway`), deliberately NOT under `/api/` (which
  skips CSRF and uses per-app Bearer keys).
- Pre-existing quirk: on a scan-blocked deploy `deployApp` leaves
  `apps.status` at "scanning". Rebuild restores it; plain deploys
  still don't.

### SSO (Google + Microsoft OAuth2)
- `packages/control/src/auth/oauth.ts` — provider configs, URL
  building, authorization code exchange, JWT payload decode. No
  external library; uses native `fetch()` for the token endpoint
  and manual base64url decode for the ID token (safe because we
  just exchanged the code over HTTPS directly with the provider).
- `packages/control/src/routes/oauth.ts` — mounted in `app.ts`
  before web routes. Contains:
  - `GET /auth/{google,microsoft}` — redirects to provider consent
  - `GET /auth/{google,microsoft}/callback` — exchanges code, then
    `decideOAuthLogin` (pure, `auth/oauth-access.ts`) decides: an
    unverified email never signs in, links or provisions (Google needs
    `email_verified`; Microsoft only counts with the optional
    `xms_edov` claim, otherwise fail closed); an existing account signs
    in and is pinned to the provider `sub` on first use; an unknown
    address gets an account ONLY if it is on the `oauth_access`
    allowlist (address or domain) or has a one-use invitation, managed
    on the Users page. All refusals show the same message and are
    audited as `oauth_denied` with the reason. `return_to` is validated
    by `safeReturnTo` (relative path or one of our hosts) at the start
    and again at the callback.
  - `GET /auth/verify` — Traefik forward-auth endpoint, called on
    every request to SSO-protected app hosts. Checks the app-host cookie
    + email allowlist (decision in `auth/forward-auth.ts`, fail-closed).
  - `GET /sso/start` — dashboard side of the handshake (see below).
- `packages/control/src/db/app-emails.ts` — per-app email allowlist
  CRUD (add, remove, check, replace-all).
- **Two separate sign-ins (S02)**: the dashboard session cookie is
  host-only (no `Domain`; `__Host-runway_session` over HTTPS, plain name
  on http for local dev; see `middleware/cookies.ts`), so an app never
  receives it. An SSO app host has its own cookie (`__Host-runway_sso`,
  host-only, 8 h, hashed in `sso_sessions`). Handshake: `/auth/verify`
  without an app cookie redirects to the dashboard `/sso/start?host&uri`;
  the dashboard (login first if needed, `runway_login_return` cookie
  carries the way back) checks the host is a known SSO app (Runway
  address or custom domain: this is what prevents an open redirect) and
  that the user is on the app's allowlist, then redirects to
  `https://<host><uri>?__runway_ticket=...`; `/auth/verify` on that host
  spends the one-time, 60 s, host-bound ticket (`sso_tickets`), sets the
  cookie and redirects to the clean URL. App sign-ins hang off the
  dashboard session (JOIN on `sessions.token`): sign-out, expiry,
  password change or deleting the user ends them. The app itself still
  receives its own host's cookie (Traefik forwards cookies); it is worth
  nothing anywhere else. Never set a cookie with `Domain=.{base_domain}`
  again, and keep the `__Host-` prefix and the "only the prefixed name is
  read over HTTPS" rule (a subdomain could otherwise plant a session).
  `migrate()` ends all dashboard sessions once (`sessions_host_only_v1`).
- **Gateway**: `writeAppRoute()` emits one router for all hostnames of the
  app, with a `forwardAuth` middleware when `ssoEnabled` is true, so the
  custom domain is protected exactly like the Runway address.
- **SSO vs basic auth**: when both are enabled on an app, SSO takes
  precedence — the forwardAuth middleware replaces basicAuth.
- OAuth client credentials are stored in the settings table
  (`oauth_google_client_id`, `oauth_google_client_secret`,
  `oauth_microsoft_client_id`, `oauth_microsoft_client_secret`).

### App ownership is a user id, not a name
- `apps.owner_user_id` is the only field rights are checked on
  (`isAppOwner`, `mayRebuild`/`mayRescan`, `requireAppAccess`,
  `appsVisibleTo`). `apps.created_by` is a historical label that keeps a
  rollback to an older release working; never compare it with a username.
- An app with `owner_user_id` NULL has no owner and is admin-only. That is
  the state after the owner was deleted (`deleteUser` clears it in the same
  transaction) and for rows that never had an owner.
- The one-time fill from the old name (`db/owner-migration.ts`) runs only in
  the transaction that adds the column. Do not make it re-run: it would
  hand an ownerless app to whoever has since taken that username.

### App containers are hardened in one place (S08)
- `deploy/hardening.ts` is the only code that sets capabilities, PID limit,
  swap, log rotation and read-only rootfs for an app container. `runContainer`
  merges its output into the HostConfig and then runs `assertSafeHostConfig`,
  which refuses Privileged, host namespaces, devices, `Mounts`, host-path
  binds (the Docker socket is one), CapAdd outside the standard list and
  `unconfined` security options. Do not add HostConfig fields to
  `runContainer` by hand.
- Profiles: `standard` (CapDrop ALL + CHOWN, DAC_OVERRIDE, FOWNER, SETGID,
  SETUID, NET_BIND_SERVICE; no-new-privileges; PidsLimit 512; MemorySwap =
  Memory; json-file 10m x 3), `strict` (same, no CapAdd), `relaxed` (Docker
  defaults, log rotation only). `apps.hardening_profile` NULL = instance
  default; `apps.readonly_rootfs` is an opt-in (tmpfs on /tmp).
- `RUNWAY_HARDENING=relaxed` on the control container is an emergency brake
  that beats a per-app `strict`; `standard`/`strict` there set the instance
  default; a typo is ignored (never turns hardening off). The compose file
  passes `RUNWAY_HARDENING` and `RUNWAY_PIDS_LIMIT` through.
- A running container keeps what it started with: a changed profile (or a
  new release of Runway) reaches an app at its next deploy, rebuild or
  rollback. The PID limit counts threads, so JVM/Node apps with big pools
  need headroom: raise `RUNWAY_PIDS_LIMIT` before relaxing a profile.
- Out of scope here: control as non-root and BuildKit privileged (S07, S16).

### The second factor has a per-user limit (S09)

`auth/twofa-limit.ts`. Every 2FA guess (authenticator code or backup code)
is charged to the USER in the `twofa_attempts` table BEFORE the code is
looked at, by `verifySecondFactor()` in `routes/web.ts`. The sign-in and
every signed-in action that asks for a code (turn 2FA off, new backup codes,
an admin resetting someone else's 2FA) use that one function and share one
counter. The 5th wrong code locks for 1 minute, the 6th for 5, the 7th to 9th
for 15, and from the 10th an hour (plus an `2fa_bruteforce_suspected` audit
line). A correct password does NOT reset it; a correct code, an admin
unlock (Users page) or 24 hours without a failure does. While a lock runs the
code is not looked at at all, so a correct code is refused like a wrong one.
Do not add a new place that calls `verifyAndConsumeTotp` for a signed-in or
pre-auth user without going through `verifySecondFactor`. The per-IP limit on
the 2FA page has its own key (`2fa:<ip>`) so the password step cannot wipe it.

### What the API does is audited by one middleware (S12)
- `middleware/api-audit.ts` sits right after `apiAuth` on `/api/v1/*` and writes
  one `audit_log` line for every POST/PUT/PATCH/DELETE (also when the request is
  refused or the handler throws) and for two sensitive reads (`GET /app/env`,
  `GET /app/source`). Do not log from the individual routes: a route added
  later is covered by construction. A test walks the route table and fails if
  a GET route is in neither `AUDITED_READS` nor `UNAUDITED_READS`, so a new
  route forces the question whether reading it is sensitive.
- A line carries `actor_type` (`api-key`, `mcp`, or NULL for a person using the
  dashboard), `app_id`, `result` (ok / rejected / denied / error),
  `source_ip` and `count`. The actor is `api-key:<app id>`: an app key is the
  only identity the API has. When user tokens arrive they get their own
  `actor_type` and their user id.
- The log says WHAT changed, never the values: `util/audit-detail.ts`
  (`describeBody`) records field names, nested key names (the env var NAMES),
  booleans and a short allow-list of scalars (`SAFE_SCALAR_FIELDS`); values of
  every other field are never read. `finalizeDetail` masks token-shaped strings
  (`rwy_`, `rwd_`, `rwu_`, `Bearer`), strips control characters and caps the
  length. Adding a field to `SAFE_SCALAR_FIELDS` is a decision that it can never
  hold a credential.
- Refused requests (`api_auth_denied`, `api_rate_limited`, `mcp_auth_denied`)
  go through `logDeniedAudit`: one row per source, action and reason per ten
  minutes with a `count`, at most 100 sources per window, the rest in one shared
  row (`source_ip = '*'`). The presented key is never stored, not even a prefix.
- `pruneApiAudit` (hourly) keeps API lines 90 days (`AUDIT_API_RETENTION_DAYS`)
  and at most 100000 (`AUDIT_API_MAX_ROWS`). Lines about people using the
  dashboard are never pruned.
- The MCP client sends `X-Runway-Client: runway-mcp`; it is shown in the log as
  a hint and decides nothing.

### Tokens are hashes, user tokens carry a scope (S10, S11, S18)
- Three kinds, by prefix (`util/token-hash.ts`): `rwy_` app key (one app, all
  of it), `rwd_` developer token (skills MCP, read-only), `rwu_` user token (a
  person, every app they may see, on `/api/v1` and `/mcp`). A secret is shown
  once and only its SHA-256 is stored (`apps.api_key_hash`,
  `dev_tokens.token_hash`, `user_tokens.token_hash`). The old plaintext
  columns hold the placeholder `hashed:<id>` (NOT NULL UNIQUE). `createApp`
  and `rotateAppKey` return the plaintext once, on the returned object; every
  later read (`getApp`) has the placeholder in `api_key`. Never add the key to
  a log, an audit detail, a response or a page. `migrateTokenStorage` is
  data-driven and idempotent; `getAppByKey` also adopts a row that still has a
  plaintext key and no hash.
- The dashboard cannot show an old key. `util/key-reveal.ts` holds a NEW key in
  memory for 10 minutes for the one person who made it (the home page
  re-renders every 5 s, so a single read is not enough); never persist it.
- Rotation (`rotateAppKey`, `POST /apps/:id/key/rotate`, `POST
  /api/v1/app/rotate-key`): the old key can keep working for 0 to 7 days
  (`prev_key_hash`, `prev_key_expires_at`); rotating again ends the earlier
  overlap, so there is at most one extra key.
- `/api/v1/*` order is `apiAuth` (who) → `apiTokenLimit` (counts every call,
  refusals too) → `apiAuthorize` (scope; for a user token the app named in
  `X-Runway-App`/`?app=` must pass `appVisibleTo`, an unknown and a foreign app
  both 404) → `apiAudit`. Tests pin the order. App keys are refused on the
  routes in `USER_TOKEN_ONLY_ROUTES`. A route not named in `ADMIN_ROUTES` and
  not a plain read needs `deploy`, so a new route is never a free read.
- Scopes are a ladder `read < deploy < admin` (`util/token-scopes.ts`). `admin`
  also needs the person to be an administrator NOW (role is read on every
  request). Rights are the dashboard's own functions (`appVisibleTo`,
  `mayRebuild`, `mayRescan`), evaluated per request. A token cannot make
  tokens: that is dashboard-only (session + CSRF).
- User tokens expire (90 days default, 1 year at most), at most 20 active per
  person, die with the person (FK cascade), revoke keeps the row (`revoked_at`,
  `revoked_by`). The administrator sees and revokes all on `/users`.

### Rate limits are per key, plus a cap on wrong keys per source (S21)
- `middleware/token-limit.ts` + `util/token-limit.ts` (pure). `apiTokenLimit`
  sits right after `apiAuth` and before `apiAudit` on `/api/v1/*`; `/mcp`
  calls `enforceTokenLimit` after it has found the token. The counter key is
  `<actor>|<bucket>` with actor `api-key:<app id>` or `mcp-token:<token id>`
  (never the secret). Buckets: `read` 120/min, `write` 60/min, `heavy` 10 per
  10 min (`HEAVY_ROUTES`: deploy, rollback, source download). Anything that is
  not a GET/HEAD is `write` by default, so a new route is never a free read;
  put an expensive new route in `HEAVY_ROUTES` (a test fails on a stale entry).
  User tokens use the same functions under the actor `user-token:<token id>`.
- Wrong keys: `guessBlocked` runs BEFORE the key is looked up and refuses a
  source (429, even for a correct key) that has presented 20 unknown keys in
  10 minutes; `recordWrongKey` counts only a key that does not exist, not a
  missing header (a monitor without credentials must not lock itself out).
  API and `/mcp` share the counter. The source address comes from
  `getClientIp` (X-Forwarded-For only from a Docker-bridge peer).
- In memory, one control process: a restart resets the counters, and several
  control processes would each have their own. `FixedWindowCounter` is capped
  at 20000 keys (expired first, then oldest) and swept hourly. The older
  per-address limiter in `rate-limit.ts` (SQLite) stays as a flood guard,
  600/min by default, because one office address is many people.
- 429 answers carry `Retry-After` and say only how long to wait. Refusals are
  one counted audit row (`api_token_rate_limited`, `auth_guess_blocked`) via
  `logDeniedAudit`; they never reach `apiAudit`. The MCP client reports a 429
  as "wait N seconds" (`packages/mcp/src/errors.ts`), never retries by itself
  and masks the key in every error message.
- Env: `RATE_LIMIT_READ_PER_MIN`, `RATE_LIMIT_WRITE_PER_MIN`,
  `RATE_LIMIT_HEAVY_PER_10MIN`, `RATE_LIMIT_AUTH_FAIL_PER_10MIN`,
  `API_IP_RATE_LIMIT`; compose passes them through. They are read on every
  request, capped at 100000, and a typo falls back to the default.

### Uploads are streamed to disk and checked before use (S06)
- `POST /api/v1/app/deploy` streams the body to `UPLOAD_DIR` (default
  `<db dir>/uploads`, on the data volume: `/tmp` is a tmpfs, i.e. RAM) with a
  hard byte cap (`deploy/upload.ts`), so a body without `Content-Length` is
  cut off at the limit instead of being read in full. The file is then
  checked entry by entry (`deploy/safe-tar.ts`, `inspectTarFile`) and only
  after that read into a Buffer for the rest of the pipeline (bounded by the
  upload limit, ceiling 2048 MB: moving the pipeline to file paths is the
  follow-up that removes the Buffer).
- Refused with 400 `{status:"rejected", code}`: gzip/zstd (the contract is a
  plain tar), absolute paths, `..`, symlinks that are absolute or leave the
  project (`..` after a real segment is refused too: if that segment is a
  link the real path differs), hard links outside, device nodes/fifos, too
  many entries (`RUNWAY_TAR_MAX_ENTRIES`, default 100000), long paths
  (`RUNWAY_TAR_MAX_PATH`), deep nesting (`RUNWAY_TAR_MAX_DEPTH`), more file
  bytes than the upload limit. A header that claims a huge size is refused
  from the header, before any data is read.
- Unpacking (`extractTarSafe`, used by `buildImageFromTar` and `scanSource`)
  is in-process with the `tar` library, async, no shell, and forces ownership
  to nobody (65534). It runs the same check first and again as a filter. Do
  not go back to `sh -c "tar xf"`. Control is still root (S07, not done):
  that is why nothing is unpacked outside these two paths, and the dep-update
  code keeps using `tar -xO` on single members.
- Stored sources and patched rebuild tars go through the same check when they
  are built or scanned, so a source stored before this change that holds an
  absolute or outward-pointing symlink now fails its rebuild with a clear
  message instead of being unpacked.
- The MCP client (`packages/mcp/src/tar.ts`) leaves such symlinks out (and
  says so) and stops at `RUNWAY_MAX_UPLOAD_MB` (default 100), mirroring the
  server, which would otherwise refuse the whole upload.

### Events are a fixed vocabulary, pulled with a cursor
- `app_events` (`db/events-schema.ts`, `db/events.ts`) is one table for every app;
  `util/events.ts` (pure) holds everything that decides what an event IS. An
  event is a code from `EVENT_CODES` (type, severity and a one-line summary come
  from that table), an app id and a few validated `facts` (CVE ids, deadlines,
  counts, ids). It never carries logs, env values, error messages or free text.
  To add an event: add the code to `EVENT_CODES`, write it with `emitEvent` at
  the place that already knows the outcome. `emitEvent` never throws (an event
  must not break a deploy) and has a windowed `dedupeKey`.
- Text that an app contributed (a package name, a base image) may only travel as
  `untrusted` and is served as `untrusted_text`, cut to 200 characters, stripped
  of control/bidi/zero-width characters, with a note that it is data. It is
  cleaned on the way in and again on the way out. The list never has it; only
  `GET /events/:id` does. Do not add a free-text field to `EventView`.
- `GET /api/v1/events?since=` returns events oldest first for exactly the apps
  the caller may see (an app key: its own; a user token: `appsVisibleTo`, an
  administrator all; `?app=` narrows, anything else 404). The cursor is `c1_` +
  the base-36 row id: monotone, opaque to clients. A cursor below the floor
  (`event_meta.floor`, the highest pruned id) or above anything issued answers
  `cursor_expired: true` with the oldest events that remain. Residual leak: ids
  are global, so gaps between the events a caller sees are other apps' events.
- Where events are written: `recordDeploy` (deploy outcomes; a rebuild's own
  deploys pass `silentEvent` because the rebuild reports one `rebuild_*` event),
  the failure branch of `POST /app/deploy`, `executeRun` in `deploy/rebuild.ts`
  (rebuild result plus dependency/base-image events, via
  `eventsForRebuildResult`), `announce`/`emitCountdown`/`emitExemptionEvents` in
  `deploy/quarantine.ts` (KEV; 7/3/1-day countdown once per deadline; exemption
  ending once per end date) and `deploy/health-watch.ts` (health transitions:
  one look a minute, a change believed after 3, at most one event per 10
  minutes per app, in-memory baseline so a restart emits nothing).
- Retention: `pruneEvents` hourly, 30 days (`EVENTS_RETENTION_DAYS`) and 500 per
  app (`EVENTS_MAX_PER_APP`). Reads count as `read` for the rate limit and are
  not audited (`UNAUDITED_READS`).
- The MCP client (`packages/mcp/src/events.ts`) rebuilds every answer field by
  field and fences `untrusted_text`; it does not pass server output through. A
  client that talks to several servers must keep one cursor per server.

### One MCP connection, several Runways (packages/mcp)
- `config.ts` decides the mode. **legacy**: no file and no `RUNWAY_TOKEN`, so
  `RUNWAY_URL` + `RUNWAY_APP_KEY`, one app key, the tools exactly as they always
  were (no `runway`/`app` arguments, error text unchanged). **config**:
  `~/.runway/config.json` (or `RUNWAY_CONFIG`), or `RUNWAY_URL` +
  `RUNWAY_TOKEN`; every app tool then also takes `runway` and `app`.
  `registerTools` reads `registry.mode` and changes the schemas, so do not add
  the routing fields unconditionally.
- `registry.ts` is the only place that picks server, app and credential
  (`clientFor`). One server: `runway` optional. Several: required and never
  guessed. A user token acts on an app via `X-Runway-App` (`clientFor` refuses a
  call with no app); an account call (events, the app list, create app) sends
  the app only as `?app=`, never as the header. An app key in `app_keys` wins for
  its app and is sent without the header. Nothing federates: a client carries
  one base URL and the one credential that belongs to it.
- `RunwayClient.send` is the one place a request leaves the process: `redirect:
  "manual"` and a 3xx is an error (never replay Authorization at another host), a
  time limit on every call, network failures reported by reason code only, and
  `readJson` never quotes the body (the parser's message does). Keep new calls
  going through it.
- Credentials never reach the model: `tools.ts` masks every secret the registry
  holds in all output (`ok`) and in errors (`fail`, with token shapes too), and a
  config error names the field, never a value (a file that is not JSON is
  reported without quoting it, because the parser quotes the text).
  `tools.test.ts` sweeps every tool against hostile server behaviour and fails if
  a tool is added without a row in its argument table.
- `multi.ts` rebuilds every answer from several servers field by field. The
  `runway` field of an event, an app or a result is written from the local config
  name, never from what a server sent. Events keep one cursor per server
  (`since`/`next` are maps `{runwayName: cursor}`); a failing server keeps the
  cursor it was given and does not block the others. `list_runways`/`list_apps`
  probe with a short timeout and four servers at a time.
- Not built on purpose: rotating an app key from the MCP (the new key would be
  shown to the model).

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
