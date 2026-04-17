#!/usr/bin/env bash
set -euo pipefail

# ── Runway Installer ─────────────────────────────────────
# Installs Docker (if needed) and starts the Runway stack.
#
# Interactive usage (recommended — the installer will ask for the
# dashboard domain and ACME email):
#   curl -fsSL https://raw.githubusercontent.com/wiggertdehaan/Runway/main/install.sh | sudo bash
#
# Non-interactive / CI usage:
#   curl -fsSL https://raw.githubusercontent.com/wiggertdehaan/Runway/main/install.sh \
#     | sudo DASHBOARD_DOMAIN=runway.example.com ACME_EMAIL=you@example.com bash
#
# Required (prompted when missing and a TTY is available):
#   DASHBOARD_DOMAIN   Domain where the Runway dashboard will be reachable.
#                     Must already point (A record) to this server.
#   ACME_EMAIL         Email address for Let's Encrypt account / expiry notices.
#
# Optional:
#   RUNWAY_REPO        Git repository to clone (default: github.com/wiggertdehaan/Runway)
#   RUNWAY_VERSION     Branch / tag / commit to check out (default: main)
#   RUNWAY_DIR         Install directory (default: /opt/runway)

RUNWAY_REPO="${RUNWAY_REPO:-https://github.com/wiggertdehaan/Runway.git}"
RUNWAY_VERSION="${RUNWAY_VERSION:-main}"
RUNWAY_DIR="${RUNWAY_DIR:-/opt/runway}"

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

log()   { echo -e "${GREEN}[runway]${NC} $*"; }
warn()  { echo -e "${YELLOW}[runway]${NC} $*"; }
error() { echo -e "${RED}[runway]${NC} $*" >&2; }

# ── Preflight ─────────────────────────────────────────────
if [ "$(id -u)" -ne 0 ]; then
  error "Please run as root (use sudo)."
  exit 1
fi

# ── Collect required config ───────────────────────────────
# Prefer explicit env vars. If anything is missing, prompt
# interactively by reading from /dev/tty — that works even when the
# installer itself is piped from curl (stdin is the pipe, not a TTY).
prompt_value() {
  local var_name="$1"
  local label="$2"
  local example="$3"
  local validator="$4"
  local value=""

  if [ ! -r /dev/tty ]; then
    error "$var_name is not set and no terminal is available to prompt."
    error "Re-run with the variable set, e.g."
    error "  sudo $var_name=$example bash install.sh"
    exit 1
  fi

  while true; do
    printf "%s [%s]: " "$label" "$example" > /dev/tty
    IFS= read -r value < /dev/tty || { echo; exit 1; }
    value="$(printf '%s' "$value" | tr -d '[:space:]')"
    if [ -z "$value" ]; then
      echo "  Required. Please enter a value." > /dev/tty
      continue
    fi
    if "$validator" "$value"; then
      printf '%s' "$value"
      return 0
    fi
    echo "  That doesn't look right. Try again." > /dev/tty
  done
}

valid_domain() {
  # Simple FQDN check: letters/digits/dashes, at least one dot.
  [[ "$1" =~ ^[a-zA-Z0-9]([a-zA-Z0-9.-]*[a-zA-Z0-9])?$ ]] \
    && [[ "$1" == *.* ]]
}

valid_email() {
  [[ "$1" =~ ^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$ ]]
}

if [ -z "${DASHBOARD_DOMAIN:-}" ]; then
  log "We need the dashboard hostname. This is where you'll log in,"
  log "e.g. runway.example.com. A wildcard DNS record for *.<this host>"
  log "should also point at this server so each app gets its own subdomain."
  DASHBOARD_DOMAIN="$(prompt_value DASHBOARD_DOMAIN 'Dashboard domain' 'runway.example.com' valid_domain)"
fi
if ! valid_domain "$DASHBOARD_DOMAIN"; then
  error "DASHBOARD_DOMAIN '$DASHBOARD_DOMAIN' is not a valid hostname."
  exit 1
fi

if [ -z "${ACME_EMAIL:-}" ]; then
  log "Let's Encrypt needs an email for certificate expiry notices."
  log "It's never shared; only used to register your ACME account."
  ACME_EMAIL="$(prompt_value ACME_EMAIL 'ACME email' 'you@example.com' valid_email)"
fi
if ! valid_email "$ACME_EMAIL"; then
  error "ACME_EMAIL '$ACME_EMAIL' is not a valid email address."
  exit 1
fi

export DASHBOARD_DOMAIN ACME_EMAIL

# ── Detect OS ─────────────────────────────────────────────
detect_os() {
  if [ -f /etc/os-release ]; then
    . /etc/os-release
    OS=$ID
    OS_VERSION=$VERSION_ID
  else
    error "Unsupported operating system"
    exit 1
  fi
}

# ── Install Docker ────────────────────────────────────────
install_docker() {
  if command -v docker &>/dev/null; then
    log "Docker already installed: $(docker --version)"
    return
  fi

  log "Installing Docker..."

  case $OS in
    ubuntu|debian)
      apt-get update -qq
      apt-get install -y -qq ca-certificates curl gnupg git
      install -m 0755 -d /etc/apt/keyrings
      curl -fsSL "https://download.docker.com/linux/$OS/gpg" | gpg --dearmor -o /etc/apt/keyrings/docker.gpg
      chmod a+r /etc/apt/keyrings/docker.gpg
      echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] https://download.docker.com/linux/$OS $(. /etc/os-release && echo "$VERSION_CODENAME") stable" > /etc/apt/sources.list.d/docker.list
      apt-get update -qq
      apt-get install -y -qq docker-ce docker-ce-cli containerd.io docker-compose-plugin
      ;;
    centos|rhel|fedora|rocky|alma)
      dnf install -y dnf-plugins-core git
      dnf config-manager --add-repo https://download.docker.com/linux/centos/docker-ce.repo
      dnf install -y docker-ce docker-ce-cli containerd.io docker-compose-plugin
      ;;
    *)
      error "Unsupported OS: $OS. Please install Docker manually and re-run."
      exit 1
      ;;
  esac

  systemctl enable --now docker
  log "Docker installed successfully"
}

# ── Configure Firewall ────────────────────────────────────
configure_firewall() {
  if command -v ufw &>/dev/null; then
    log "Configuring UFW firewall..."
    ufw allow 22/tcp
    ufw allow 80/tcp
    ufw allow 443/tcp
    ufw --force enable
  elif command -v firewall-cmd &>/dev/null; then
    log "Configuring firewalld..."
    firewall-cmd --permanent --add-service=ssh
    firewall-cmd --permanent --add-service=http
    firewall-cmd --permanent --add-service=https
    firewall-cmd --reload
  else
    warn "No firewall detected. Consider configuring one manually."
  fi
}

# ── Clone & Start ─────────────────────────────────────────
install_runway() {
  log "Installing Runway to $RUNWAY_DIR..."

  if [ -d "$RUNWAY_DIR/.git" ]; then
    warn "Existing installation found at $RUNWAY_DIR, pulling latest"
    git -C "$RUNWAY_DIR" fetch origin "$RUNWAY_VERSION"
    git -C "$RUNWAY_DIR" checkout "$RUNWAY_VERSION"
    git -C "$RUNWAY_DIR" pull --ff-only origin "$RUNWAY_VERSION"
  else
    git clone --branch "$RUNWAY_VERSION" --depth 1 "$RUNWAY_REPO" "$RUNWAY_DIR"
  fi

  cd "$RUNWAY_DIR"

  # Write .env (compose reads this)
  log "Writing configuration to $RUNWAY_DIR/.env"
  cat > .env <<EOF
DASHBOARD_DOMAIN=$DASHBOARD_DOMAIN
ACME_EMAIL=$ACME_EMAIL
EOF
  chmod 600 .env

  log "Building and starting Runway stack..."
  docker compose up -d --build

  wait_for_tls_cert "$DASHBOARD_DOMAIN"

  echo ""
  echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
  log "Runway is running!"
  echo ""
  log "Dashboard:  https://$DASHBOARD_DOMAIN"
  log "            Open the URL above to create your admin account,"
  log "            then click \"Generate new API key\" for each app."
  log ""
  log "Agent docs: https://$DASHBOARD_DOMAIN/llms.txt"
  log "            Hand this URL + your API key to Claude Code and"
  log "            ask it to deploy your project."
  log ""
  log "Config:     $RUNWAY_DIR/.env"
  log "Logs:       docker compose -f $RUNWAY_DIR/docker-compose.yml logs -f"
  echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
}

# ── TLS cert sanity check ─────────────────────────────────
# After the stack is up, Traefik asks Let's Encrypt for a certificate
# via the HTTP-01 challenge. That can take 10-60 seconds, so poll for
# a short while before declaring success. If it times out, point the
# user at the most common failure modes — rate limits, firewalled
# port 80, bad DNS — so they don't have to go digging through docs.
wait_for_tls_cert() {
  local domain="$1"
  local attempts=40   # 40 * 3s = 2 minutes
  local delay=3

  log "Waiting for Let's Encrypt certificate for $domain ..."

  for ((i = 1; i <= attempts; i++)); do
    # curl without -k: succeeds only when the cert chain actually verifies.
    if curl -sSI --max-time 5 "https://$domain/login" >/dev/null 2>&1; then
      log "TLS certificate issued and verified."
      return 0
    fi
    sleep "$delay"
  done

  warn "No valid TLS certificate after $((attempts * delay))s."
  warn ""
  warn "Runway is running — but Let's Encrypt has not issued a cert yet."
  warn "Common causes:"
  warn "  1. DNS for $domain isn't pointing at this server yet."
  warn "     Check: getent hosts $domain"
  warn "  2. Port 80 is blocked (cloud firewall, security group, ISP)."
  warn "     Let's Encrypt's HTTP-01 challenge needs port 80 reachable."
  warn "  3. Rate limit — repeated reinstalls on the same domain hit"
  warn "     LE's 'duplicate certificate' limit (5 per week)."
  warn ""
  warn "Inspect the issuer logs to see which one:"
  warn "  docker logs runway-gateway 2>&1 | grep -iE 'acme|error|ratelimit' | tail -30"
  warn ""
  warn "Once the underlying issue is fixed, restart Traefik to retry:"
  warn "  docker compose -f $RUNWAY_DIR/docker-compose.yml restart gateway"
}

# ── Main ──────────────────────────────────────────────────
main() {
  log "Starting Runway installation..."
  detect_os
  log "Detected OS: $OS $OS_VERSION"
  install_docker
  configure_firewall
  install_runway
}

main "$@"
