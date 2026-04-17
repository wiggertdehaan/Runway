#!/usr/bin/env bash
set -euo pipefail

# ── Runway Installer ─────────────────────────────────────
# Installs Docker (if needed) and starts the Runway stack.
#
# Usage:
#   curl -fsSL https://raw.githubusercontent.com/wiggertdehaan/Runway/main/install.sh \
#     | sudo DASHBOARD_DOMAIN=runway.example.com ACME_EMAIL=you@example.com bash
#
# Required environment variables:
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

if [ -z "${DASHBOARD_DOMAIN:-}" ] || [ -z "${ACME_EMAIL:-}" ]; then
  error "DASHBOARD_DOMAIN and ACME_EMAIL must be set."
  error ""
  error "Example:"
  error "  sudo DASHBOARD_DOMAIN=runway.example.com \\"
  error "       ACME_EMAIL=you@example.com \\"
  error "       bash install.sh"
  exit 1
fi

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
