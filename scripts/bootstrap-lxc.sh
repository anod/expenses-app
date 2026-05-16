#!/usr/bin/env bash
# bootstrap-lxc.sh — one-shot setup of the Expenses app inside a fresh
# Proxmox LXC. Idempotent: re-running upgrades the stack in place.
#
# Prerequisites:
#   1. LXC created via the Proxmox community-script ct/docker.sh
#      (Docker + Compose already installed, nesting=1, keyctl=1).
#   2. Run AS ROOT inside the LXC.
#
# Environment variables (override on the command line, e.g.
#   TS_HOSTNAME=my-app sudo -E ./bootstrap-lxc.sh):
#
#   TS_HOSTNAME       Hostname for Tailscale (default: expenses)
#   TS_AUTHKEY        Tailscale auth key (optional; if unset, runs
#                     `tailscale up` interactively).
#   IMAGE             Container image to pull
#                     (default: ghcr.io/anod/expenses-app:latest).
#   APP_DIR           Where to place compose.deploy.yml + .env.prod
#                     and the data volume (default: /opt/expenses).
#   GHCR_USER/GHCR_PAT
#                     Optional: only needed if the GHCR package is
#                     still private. Public packages need no login.
set -euo pipefail

TS_HOSTNAME="${TS_HOSTNAME:-expenses}"
IMAGE="${IMAGE:-ghcr.io/anod/expenses-app:latest}"
APP_DIR="${APP_DIR:-/opt/expenses}"

log() { printf '\033[1;34m==>\033[0m %s\n' "$*"; }
die() { printf '\033[1;31m!!\033[0m  %s\n' "$*" >&2; exit 1; }

[[ $EUID -eq 0 ]] || die "Run as root."
command -v docker >/dev/null   || die "Docker not found; run the community-script ct/docker.sh first."
docker compose version >/dev/null 2>&1 || die "Docker Compose v2 plugin not found."

# ---------- Tailscale ---------------------------------------------------------
if ! command -v tailscale >/dev/null; then
  log "Installing Tailscale"
  curl -fsSL https://tailscale.com/install.sh | sh
fi
if ! tailscale status >/dev/null 2>&1; then
  log "Bringing Tailscale up (hostname=$TS_HOSTNAME)"
  if [[ -n "${TS_AUTHKEY:-}" ]]; then
    tailscale up --authkey "$TS_AUTHKEY" --hostname "$TS_HOSTNAME" --ssh
  else
    tailscale up --hostname "$TS_HOSTNAME" --ssh
  fi
else
  log "Tailscale already up: $(tailscale status --self --json | grep -oE '"DNSName":"[^"]+"' | head -1 || echo OK)"
fi

# ---------- App directory + data volume --------------------------------------
log "Preparing $APP_DIR"
mkdir -p "$APP_DIR/data"
chown -R 1000:1000 "$APP_DIR/data"

if [[ ! -f "$APP_DIR/compose.deploy.yml" ]]; then
  log "Fetching compose.deploy.yml from the repo"
  curl -fsSL -o "$APP_DIR/compose.deploy.yml" \
    https://raw.githubusercontent.com/anod/expenses-app/main/compose.deploy.yml
fi

if [[ ! -f "$APP_DIR/.env.prod" ]]; then
  log "Fetching .env.prod.example -> $APP_DIR/.env.prod"
  curl -fsSL -o "$APP_DIR/.env.prod" \
    https://raw.githubusercontent.com/anod/expenses-app/main/.env.prod.example
  cat <<EOF

  $APP_DIR/.env.prod was just created from the template. Edit it now:
    - MICROSOFT_CLIENT_ID
    - ONEDRIVE_WORKBOOK_URL
  Then re-run this script (it will pick up where it left off).
EOF
  exit 0
fi

# ---------- GHCR login (only if package is private) --------------------------
if [[ -n "${GHCR_USER:-}" && -n "${GHCR_PAT:-}" ]]; then
  log "Logging in to ghcr.io as $GHCR_USER"
  echo "$GHCR_PAT" | docker login ghcr.io -u "$GHCR_USER" --password-stdin
fi

# ---------- Pull + run -------------------------------------------------------
cd "$APP_DIR"
export EXPENSES_IMAGE="$IMAGE"
log "Pulling $IMAGE"
docker compose -f compose.deploy.yml pull
log "Starting stack"
docker compose -f compose.deploy.yml up -d
log "Waiting for healthz"
for i in {1..30}; do
  if curl -fsS http://127.0.0.1:4000/healthz >/dev/null 2>&1; then
    log "Container is healthy"
    break
  fi
  sleep 2
  [[ $i -eq 30 ]] && die "Container failed to become healthy in 60s — check 'docker logs expenses'"
done

# ---------- Tailscale Serve (HTTPS on 443) -----------------------------------
if ! tailscale serve status 2>/dev/null | grep -q '4000'; then
  log "Configuring tailscale serve --https=443 -> http://127.0.0.1:4000"
  tailscale serve --bg --https=443 http://127.0.0.1:4000 || \
    log "tailscale serve failed; you can run it manually after this script"
fi

# ---------- Backup cron ------------------------------------------------------
CRON_LINE='0 3 * * * docker exec expenses node /app/apps/api/dist/scripts/backup-db.js >> /var/log/expenses-backup.log 2>&1'
if ! crontab -l 2>/dev/null | grep -q 'backup-db.js'; then
  log "Installing daily backup cron (03:00 UTC)"
  ( crontab -l 2>/dev/null; echo "$CRON_LINE" ) | crontab -
fi

log "Done."
echo
tailscale status --self 2>/dev/null | head -1 || true
echo "App URL (tailnet): https://$(tailscale status --json 2>/dev/null | grep -oE '"DNSName":"[^"]+"' | head -1 | cut -d'"' -f4 | sed 's/\.$//')"
