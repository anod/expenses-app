#!/usr/bin/env bash
# update.sh — pull the latest image and restart the stack.
# Run inside the LXC, in $APP_DIR (default /opt/expenses).
set -euo pipefail

APP_DIR="${APP_DIR:-/opt/expenses}"
cd "$APP_DIR"

echo "==> Pulling latest image"
docker compose -f compose.deploy.yml pull
echo "==> Restarting stack"
docker compose -f compose.deploy.yml up -d
echo "==> Waiting for healthz"
for i in {1..30}; do
  curl -fsS http://127.0.0.1:4000/healthz >/dev/null 2>&1 && { echo "OK"; exit 0; }
  sleep 2
done
echo "!!  Container failed to become healthy; check 'docker logs expenses'" >&2
exit 1
