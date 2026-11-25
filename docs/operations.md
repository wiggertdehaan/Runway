# Operations

Running Runway day to day: updating it, keeping the apps on it patched, reading
the server figures and limiting what apps can reach.

- [Update Runway](#update-runway)
- [Keep apps patched](#keep-apps-patched)
- [KEV countdown and quarantine](#kev-countdown-and-quarantine)
- [The trash and purge](#the-trash-and-purge)
- [Server figures](#server-figures)
- [Limit what apps can reach (egress rules)](#limit-what-apps-can-reach-egress-rules)
- [Health, audit and backups](#health-audit-and-backups)
- [Upgrade notes](#upgrade-notes)

## Update Runway

Runway's own containers (gateway, BuildKit, control) are pinned in
`docker-compose.yml`: Traefik and BuildKit each on an exact release, never
`latest`. To update, from the install directory (`/opt/runway`):

```bash
git pull                        # picks up new pins and control changes
docker compose pull             # fetch the pinned images
docker compose up -d --build    # recreate what changed, rebuild control
```

This sequence is safe in a scheduled job. `up -d` only recreates containers whose
image or config changed, and deployed apps live in separate containers that are
not touched. To move BuildKit or Traefik to a newer release, change the tag in
`docker-compose.yml` first.

Recreating the gateway detaches it from the app networks. Control reattaches it by
itself, at startup and once a minute, so routes that answer 502 right after an update
come back within a minute. To do it at once, run `docker compose restart control`.

## Keep apps patched

An app only becomes safe when it is rebuilt. The **Rebuild** page (admins) does
that from the stored source with `buildctl --no-cache`, through the normal scan
gate. A new container that is not healthy within two minutes is replaced by the
previous version automatically.

**Two buttons.**

- **Rebuild apps with issues** is the default: the same selection as the weekly
  run (an actively exploited CVE, a critical finding that has a fix, or a
  dependency update Runway may apply), plus apps that have automatic rebuild
  switched off, because a person asked. It lists which apps it will touch and
  why, and is disabled with "Nothing needs a rebuild" when there are none.
- **Rebuild all apps** sits behind a confirmation in the page.

Rebuilds run one app after another, one run at a time. Each app gets a result
(rebuilt, old version kept, failed, skipped) with the findings before and after,
including actively exploited CVEs from the CISA KEV catalogue. An owner can also
rebuild their own app from its page, under the same one-at-a-time rule.

**The weekly run.** Default Sunday 05:00 Europe/Amsterdam, configurable on the
Rebuild page. It rebuilds only apps with issues. An app can opt out on its page.
The result goes to the notification webhook.

**Automatic maintenance.** Each app page has an **Automatic maintenance** card
with five switches, changed by admins and written to the audit log:

- **Weekly rebuild**: include the app in the weekly run (default on).
- **Patch the base image**: when a `FROM` pins an exact patch
  (`nginx:1.30.6-alpine`), a rebuild looks up the newest patch of the same
  major.minor and variant in the registry and builds with it from a build-time
  copy of the Dockerfile. Your stored source is never changed. Never a different
  minor or major. Digest pins and floating tags (`1.30-alpine`, `node:24`,
  `latest`) are left alone (default on).
- **Minor escalation**: if patching still leaves an actively exploited CVE or a
  critical with a fix, Runway tries the lowest newer minor line of the same major
  and variant, up to three lines, for the final stage only. A minor is used only
  if it resolves all targeted findings, is not worse than the running version
  and passes its health check (default on).
- **Update vulnerable dependencies**: on rebuild, Runway raises your own Python
  (`requirements.txt`) and Node (`package.json`, with `package-lock.json`)
  packages that have a known vulnerability with a fix, within the installed major
  version. An update goes live only if the scan improves and the app still
  starts. The changed files are saved as a new source snapshot, and your upload
  stays in the earlier one. Not handled yet: yarn, pnpm and bun lockfiles,
  `pyproject.toml`, Pipfile, hash-pinned requirements (default on).
- **Allow major updates**: off by default. A health check only proves the app
  starts, not that a major update leaves it working, so while this is off a
  rebuild only reports the major update that is available.

**The rebuild gate.** A rebuild goes live only if it is not worse than the running
version (no new CRITICAL and no new actively exploited CVE compared with a fresh
scan of the running image) and the new container passes its health check.
Otherwise the old version keeps running and the reason is reported. The app's own
`scan_threshold` still gates normal deploys, not rebuilds.

**Scripting.** `POST /admin/api/rebuild-all` (returns 202 and a `run_id`) and
`GET /admin/api/rebuild-runs[/<id>]` need an admin dashboard session cookie and the
header `X-Requested-With: runway`. App keys and user tokens cannot call them.

## KEV countdown and quarantine

An actively exploited CVE (on CISA's Known Exploited Vulnerabilities list) in a
running app's runtime packages (build stages never count) starts a term, 7 days by
default and an admin setting on the Rebuild page. The owner gets a notice on day 0
(app page, dashboard and webhook), the app page shows the countdown at the top
with three steps in plain words (rebuild now, ask your agent with a prompt you can
copy, get more time from an admin), and `kev_*` events are raised for agents.

When the term ends, Runway makes one last rebuild attempt, with minor escalation.
If the CVE is still there, the app is **quarantined**: its hostnames are routed to a
public maintenance page (HTTP 503) and the container is stopped. Named volumes and
data stay. As soon as a rebuild or deploy produces an image without the CVE the app
comes back by itself, and it is never restored to the vulnerable image. An admin can
grant a time-boxed **exemption** (a reason and an end date, at most 90 days, audited)
on the app page, which lifts an active quarantine. Ordinary criticals never
quarantine anything.

## The trash and purge

Deleting an app in the dashboard, API or MCP moves it to the trash. It is stopped,
hidden from the lists and from every job (rebuilds, scans, health, quarantine), and
keeps its row, container, image, volumes, environment, stored source and address for
7 days. Its domain stays reserved: no other app can take the name or the hostname
meanwhile. The owner or an admin restores it from the **Deleted** filter; it returns
as a stopped app. A trashed app's key answers HTTP 410.

**Purge.** Control removes trashed apps older than 7 days: once at every start (so a
long downtime catches up) and then every hour, logged as `[trash] purged <id>`. A
purge removes the container, the app's network, the gateway route and the stored
sources, then the database row, which takes the app's deploys, settings and events with
it. The sweep is idempotent and one failing app does not stop the rest; a failed one is
retried at the next sweep. An admin can purge at once with **Delete now** in the trash
(name typed again). Every purge is in the audit log (`app_purged`); the app's own events
go with the app.

**Named Docker volumes are not removed** by a purge, as before: an app's data volumes
(`runway-data-<id>-...`) stay on the server until you remove them yourself
(`docker volume ls`, `docker volume rm`). Do that only when you are sure the data is
not needed, because it cannot be recovered.

**Stopped apps** (stopped by a person, as opposed to quarantined) are skipped by the
weekly rebuild and manual rebuilds, the health watcher, the daily scans and the KEV
quarantine; their KEV fix period pauses and continues at Start.

## Server figures

On `/overview`, admins also see the server's disk, CPU, memory and Docker data
(volumes, images, build cache). Runway reads them from inside its own container,
with no extra mount or privilege:

- CPU and memory from `/proc`, every minute, kept as 5-minute means
- disk from `statfs` on the data volume, every 5 minutes
- Docker data from `docker system df` and `buildctl du` over the Docker socket it
  already uses, every 15 minutes

They are kept 60 days. A disk at 80% puts an item under "This week" in the overview
inbox, at 90% under "Needs you now".

The readings distrust themselves. When a value looks like the container's own view
and not the host's (a memory limit not smaller than `MemTotal`, a tiny or
memory-backed data volume), the page shows it grey as "Container view, not the
host" and writes one `host_metrics_container_view` line to the audit log. A reading
that fails keeps the previous value with "measured N min ago", or says "No data
yet". `HOST_METRICS_INTERVAL_MS=0` turns the measuring off.

To check on the host that the numbers are real, compare:

```bash
df -h /var/lib/docker                       # Use% should equal the Disk figure
head -1 /proc/meminfo                       # MemTotal on the host ...
docker exec runway-control head -1 /proc/meminfo   # ... should be the same inside
docker system df                            # roughly the Data figure (decimal GB)
```

## Limit what apps can reach (egress rules)

Every app runs on its own Docker network, so apps cannot reach each other or the
control plane by name. What they can reach outside Docker is a host firewall
matter, so it is an explicit, reversible step and not part of the default install.
`scripts/egress-rules.sh` refuses traffic from the app and build networks to the
cloud metadata address (`169.254.169.254`), private ranges (RFC1918, `100.64.0.0/10`
which includes Tailscale) and the host itself, and leaves the internet alone. It
only ever matches those interfaces, so SSH and the rest of the host are untouched.

```bash
sudo /opt/runway/scripts/egress-rules.sh plan      # show what it would do, change nothing
sudo /opt/runway/scripts/egress-rules.sh apply     # install the rules (safe to repeat)
sudo /opt/runway/scripts/egress-rules.sh status
sudo /opt/runway/scripts/egress-rules.sh remove    # roll back
sudo /opt/runway/scripts/egress-rules.sh persist   # print a systemd unit that re-applies at boot
```

Options: `--allow-net 10.20.0.0/24` lets apps reach a private destination after all
(an internal API over a VPN), and `--allow-dns IP` names a resolver that is a private
address. The rules live in the kernel only and are gone after a reboot unless you
install the unit that `persist` prints. After `apply`, check from an app container
that DNS and the internet still work and that the metadata address does not answer.
The rules cover IPv4. `RUNWAY_EGRESS=1` on the installer does the `apply` for you.

## Health, audit and backups

- **Health** (admins): a page with the checks for Docker, BuildKit, wildcard DNS,
  Traefik and the scanner (binary, cache and vulnerability database).
- **Audit** (admins): every admin action, sign-in and failed attempt, and what API
  keys and tokens did (which field changed, never the value). Refused requests are
  counted in one line per source and ten minutes. Filter on everything, people,
  API and MCP, or refused.
- **Backups**: `scripts/backup-db.sh` makes a consistent SQLite snapshot with
  `sqlite3 .backup` (the `sqlite3` command must be installed) and keeps the last 7.
  See [Configuration](configuration.md#where-state-lives) for the volumes.

## Upgrade notes

Things that change behaviour for people when you upgrade from an older install:

- **Sessions.** The first start after the host-only cookie change ends every
  dashboard session once, so everyone signs in again.
- **App keys.** Keys are stored as hashes and cannot be shown again. Existing keys
  keep working. Rotate one on the app page when you need a new copy.
- **Per-app networks.** Apps deployed before the change stay on the shared
  `runway-apps` network until their next deploy or rebuild. Control logs how many.
- **Container hardening** applies to an app at its next deploy or rebuild.
  `RUNWAY_HARDENING=relaxed` is the emergency brake.
- **OAuth sign-in** no longer creates accounts for everyone. Fill the allowlist on the
  **Users** page before people sign in with Google or Microsoft for the first time.
- **Duplicate domains.** If two apps already share a domain, Runway logs it and writes a
  `domain_duplicates_detected` audit line instead of failing; rename one of the apps.
- **Ownerless apps.** Apps whose owner no longer exists become admin-only
  (`app_owner_unlinked` in the audit log). Assign an owner on the app's **Config** tab.
- **App descriptions** (0.49 and 0.50). The first start of 0.50 fills empty descriptions
  once, in the background, from the stored sources (`[description-backfill]` lines in
  the control log; it does not delay the start).
- **Stop and the trash** (0.51). Existing apps are unaffected: nothing is stopped or in
  the trash until somebody does it. The purge sweep starts with control.
- **Skill tokens** (`rwd_`) that had no expiry got one of 90 days at the upgrade.
