#!/usr/bin/env bash
# Runway egress rules for app containers (S04 / S15). Run on the Docker HOST,
# as root. Not part of the default install: it is an explicit, reversible step.
#
#   egress-rules.sh plan      Show what `apply` would do. Changes nothing, needs no root.
#   egress-rules.sh apply     Create the rules (idempotent: safe to run again).
#   egress-rules.sh status    Show whether the rules are installed. Exit 0 = installed.
#   egress-rules.sh remove    ROLLBACK: delete every rule and chain this script created.
#   egress-rules.sh persist   Print a systemd unit that re-applies the rules at boot (installs nothing).
#
# Options (before or after the command):
#   --dry-run            Print the commands instead of running them (plan is the same thing).
#   --allow-dns IP[,IP]  Resolver(s) the apps may reach even though they are private addresses.
#                        Detected from /etc/resolv.conf when not given; `plan` prints what it found.
#   --allow-net CIDR[,CIDR]  Private destinations the apps may reach after all (an internal API over a
#                        VPN, a private package registry), e.g. --allow-net 10.20.0.0/24. Not applied to
#                        the host itself. Repeat the option, or comma-separate, for several.
#   --no-host-guard      Only filter traffic that is forwarded (leave the INPUT rules out).
#
# What it does. App containers are on bridge networks whose interface names
# start with `rwa-` (see deploy/networks.ts), plus the old shared network and
# the BuildKit network, which are looked up by name. For traffic that comes
# from those interfaces:
#
#   FORWARD path (chain RUNWAY-EGRESS, called from DOCKER-USER):
#     - answers to connections that came in, and traffic inside one bridge
#       (gateway <-> app), pass untouched;
#     - to the detected resolvers on port 53: allowed;
#     - to link-local (cloud metadata, 169.254.0.0/16), RFC1918 (10/8,
#       172.16/12, 192.168/16) and 100.64.0.0/10 (carrier-grade NAT and
#       Tailscale): refused with an ICMP "administratively prohibited";
#     - everything else (the internet) is left to Docker as before.
#   INPUT path (chain RUNWAY-HOSTGUARD): anything an app container sends to the
#     host itself (its bridge address, its public IP) is refused, except
#     answers to connections the host started.
#
# It never touches traffic that does not enter through one of those
# interfaces, so SSH and everything else on the host is unaffected. Rules live in
# the kernel only: they are gone after a reboot unless you install the unit that
# `persist` prints.
#
# Test overrides (used by the test suite; not for production):
#   RUNWAY_EGRESS_BRIDGES   comma list of extra interface selectors (skips the docker lookup)
#   RUNWAY_EGRESS_DNS       comma list of resolvers (skips /etc/resolv.conf detection)
#   RUNWAY_EGRESS_NETWORKS  space-separated Docker network names to look up
#   RUNWAY_EGRESS_SKIP_ROOT_CHECK=1  skip the root check (the tests put a fake iptables first in PATH)
set -euo pipefail

FWD_CHAIN="RUNWAY-EGRESS"
IN_CHAIN="RUNWAY-HOSTGUARD"
APP_BRIDGES="rwa+"
NETWORKS="${RUNWAY_EGRESS_NETWORKS:-runway-apps runway-build}"
PRIVATE_NETS="169.254.0.0/16 10.0.0.0/8 172.16.0.0/12 192.168.0.0/16 100.64.0.0/10"
REJECT="-j REJECT --reject-with icmp-admin-prohibited"

DRY=0
HOST_GUARD=1
EXTRA_DNS=""
ALLOW_NETS=""
CMD=""

die() { echo "egress-rules: $*" >&2; exit 1; }

usage() { awk 'NR>1 && /^#/ { sub(/^# ?/, ""); print; next } NR>1 { exit }' "$0"; }

while [ $# -gt 0 ]; do
  case "$1" in
    plan|apply|status|remove|persist) CMD="$1" ;;
    --dry-run) DRY=1 ;;
    --no-host-guard) HOST_GUARD=0 ;;
    --allow-dns) shift; [ $# -gt 0 ] || die "--allow-dns needs a value"; EXTRA_DNS="${EXTRA_DNS:+$EXTRA_DNS,}$1" ;;
    --allow-net) shift; [ $# -gt 0 ] || die "--allow-net needs a value"; ALLOW_NETS="${ALLOW_NETS:+$ALLOW_NETS,}$1" ;;
    -h|--help|help) usage; exit 0 ;;
    *) die "unknown argument: $1 (try --help)" ;;
  esac
  shift
done
[ -n "$CMD" ] || { usage; exit 1; }
if [ "$CMD" = "plan" ]; then DRY=1; CMD="apply"; fi

# ── helpers ──────────────────────────────────────────────

ipt() {
  if [ "$DRY" = 1 ]; then echo "iptables -w $*"; else iptables -w "$@"; fi
}

# Resolvers the apps may use. Loopback ones are skipped: Docker already
# handles those on its own, and they are not reachable from a container.
detect_dns() {
  if [ -n "${RUNWAY_EGRESS_DNS:-}" ]; then
    echo "$RUNWAY_EGRESS_DNS" | tr ',' '\n'
  else
    for f in /etc/resolv.conf /run/systemd/resolve/resolv.conf; do
      [ -r "$f" ] && awk '$1=="nameserver"{print $2}' "$f"
    done
  fi
  [ -n "$EXTRA_DNS" ] && echo "$EXTRA_DNS" | tr ',' '\n'
  return 0
}

# Only resolvers inside the blocked ranges need an exception; a public resolver is reachable anyway.
dns_list() {
  detect_dns | tr -d ' ' | grep -E '^(10\.|172\.(1[6-9]|2[0-9]|3[01])\.|192\.168\.|100\.(6[4-9]|[7-9][0-9]|1[01][0-9]|12[0-7])\.|169\.254\.)[0-9.]+$' | sort -u || true
}

# Destinations the admin allowed on purpose, one per line, validated as IPv4 CIDRs.
allow_list() {
  [ -n "$ALLOW_NETS" ] || return 0
  echo "$ALLOW_NETS" | tr ',' '\n' | tr -d ' ' | while read -r n; do
    [ -n "$n" ] || continue
    echo "$n" | grep -Eq '^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+(/[0-9]+)?$' || die "--allow-net: not an IPv4 address or CIDR: $n"
    echo "$n"
  done
}

# Interface selectors, one per line: rwa+ and the bridges of the named networks.
interfaces() {
  echo "$APP_BRIDGES"
  if [ -n "${RUNWAY_EGRESS_BRIDGES:-}" ]; then
    echo "$RUNWAY_EGRESS_BRIDGES" | tr ',' '\n'
    return 0
  fi
  command -v docker >/dev/null 2>&1 || { echo "egress-rules: docker not found, only rwa+ networks are covered" >&2; return 0; }
  for net in $NETWORKS; do
    id=$(docker network inspect -f '{{.Id}}' "$net" 2>/dev/null || true)
    [ -n "$id" ] || { echo "egress-rules: network $net not found, skipped" >&2; continue; }
    name=$(docker network inspect -f '{{index .Options "com.docker.network.bridge.name"}}' "$net" 2>/dev/null || true)
    [ -n "$name" ] && [ "$name" != "<no value>" ] || name="br-$(echo "$id" | cut -c1-12)"
    echo "$name"
  done
}

require_root_and_chains() {
  [ "$DRY" = 1 ] && return 0
  if [ "${RUNWAY_EGRESS_SKIP_ROOT_CHECK:-}" != 1 ]; then
    [ "$(id -u)" -eq 0 ] || die "run as root (sudo), or use plan to see what would happen"
  fi
  command -v iptables >/dev/null 2>&1 || die "iptables not found"
  iptables -w -n -L DOCKER-USER >/dev/null 2>&1 || die "chain DOCKER-USER does not exist: is Docker running?"
}

ensure_chain() {
  if [ "$DRY" = 1 ]; then echo "# create chain $1, or flush it when it exists"; echo "iptables -w -N $1  (or -F $1)"; return 0; fi
  if iptables -w -n -L "$1" >/dev/null 2>&1; then iptables -w -F "$1"; else iptables -w -N "$1"; fi
}

ensure_jump() { # parent chain
  if [ "$DRY" = 1 ]; then echo "iptables -w -I $1 1 -j $2   # only when not there yet"; return 0; fi
  iptables -w -C "$1" -j "$2" 2>/dev/null || iptables -w -I "$1" 1 -j "$2"
}

drop_jump() {
  if [ "$DRY" = 1 ]; then echo "iptables -w -D $1 -j $2   # while present"; return 0; fi
  while iptables -w -C "$1" -j "$2" 2>/dev/null; do iptables -w -D "$1" -j "$2"; done
}

drop_chain() {
  if [ "$DRY" = 1 ]; then echo "iptables -w -F $1; iptables -w -X $1   # when it exists"; return 0; fi
  if iptables -w -n -L "$1" >/dev/null 2>&1; then iptables -w -F "$1"; iptables -w -X "$1"; fi
}

# ── commands ─────────────────────────────────────────────

do_apply() {
  require_root_and_chains
  dns="$(dns_list)"
  allow="$(allow_list)"
  ifaces="$(interfaces)"
  if [ "$DRY" = 1 ]; then
    echo "# interfaces covered:"; echo "$ifaces" | sed 's/^/#   /'
    echo "# resolvers allowed on port 53 (only those inside the blocked ranges matter): $(echo "$dns" | tr '\n' ' ')"
    [ -z "$allow" ] || echo "# private destinations allowed on purpose: $(echo "$allow" | tr '\n' ' ')"
    [ -n "$dns" ] || echo "# none found: if the host resolver is a private address, pass --allow-dns IP or DNS in app containers will stop working"
  fi

  ensure_chain "$FWD_CHAIN"
  ipt -A "$FWD_CHAIN" -m conntrack --ctstate RELATED,ESTABLISHED -j RETURN
  ipt -A "$FWD_CHAIN" -m physdev --physdev-is-bridged -j RETURN
  echo "$ifaces" | while read -r i; do
    [ -n "$i" ] || continue
    echo "$dns" | while read -r d; do
      [ -n "$d" ] || continue
      ipt -A "$FWD_CHAIN" -i "$i" -d "$d" -p udp --dport 53 -j RETURN
      ipt -A "$FWD_CHAIN" -i "$i" -d "$d" -p tcp --dport 53 -j RETURN
    done
    echo "$allow" | while read -r a; do
      [ -n "$a" ] || continue
      ipt -A "$FWD_CHAIN" -i "$i" -d "$a" -j RETURN
    done
    for n in $PRIVATE_NETS; do
      ipt -A "$FWD_CHAIN" -i "$i" -d "$n" $REJECT
    done
  done
  ensure_jump DOCKER-USER "$FWD_CHAIN"

  if [ "$HOST_GUARD" = 1 ]; then
    ensure_chain "$IN_CHAIN"
    ipt -A "$IN_CHAIN" -m conntrack --ctstate RELATED,ESTABLISHED -j ACCEPT
    echo "$ifaces" | while read -r i; do
      [ -n "$i" ] || continue
      echo "$dns" | while read -r d; do
        [ -n "$d" ] || continue
        ipt -A "$IN_CHAIN" -i "$i" -d "$d" -p udp --dport 53 -j ACCEPT
        ipt -A "$IN_CHAIN" -i "$i" -d "$d" -p tcp --dport 53 -j ACCEPT
      done
      ipt -A "$IN_CHAIN" -i "$i" $REJECT
    done
    ensure_jump INPUT "$IN_CHAIN"
  fi
  [ "$DRY" = 1 ] || echo "egress-rules: applied. Rules are not persistent: see '$0 persist'."
}

do_remove() {
  require_root_and_chains
  drop_jump DOCKER-USER "$FWD_CHAIN"
  drop_jump INPUT "$IN_CHAIN"
  drop_chain "$FWD_CHAIN"
  drop_chain "$IN_CHAIN"
  [ "$DRY" = 1 ] || echo "egress-rules: removed."
}

do_status() {
  command -v iptables >/dev/null 2>&1 || die "iptables not found"
  ok=1
  if iptables -w -C DOCKER-USER -j "$FWD_CHAIN" 2>/dev/null; then
    echo "forward rules: installed (DOCKER-USER -> $FWD_CHAIN)"; iptables -w -n -v -L "$FWD_CHAIN"
  else
    echo "forward rules: NOT installed"; ok=0
  fi
  if iptables -w -C INPUT -j "$IN_CHAIN" 2>/dev/null; then
    echo "host guard:    installed (INPUT -> $IN_CHAIN)"; iptables -w -n -v -L "$IN_CHAIN"
  else
    echo "host guard:    NOT installed"
  fi
  [ "$ok" = 1 ]
}

do_persist() {
  here="$(cd "$(dirname "$0")" && pwd)/$(basename "$0")"
  cat <<EOF
# /etc/systemd/system/runway-egress.service   (print only: nothing was installed)
[Unit]
Description=Runway egress rules for app containers
After=docker.service network-online.target
Requires=docker.service

[Service]
Type=oneshot
RemainAfterExit=yes
ExecStart=$here apply
ExecStop=$here remove

[Install]
WantedBy=multi-user.target
EOF
}

case "$CMD" in
  apply) do_apply ;;
  remove) do_remove ;;
  status) do_status ;;
  persist) do_persist ;;
esac
