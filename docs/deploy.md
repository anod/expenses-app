# Deploying to Proxmox LXC via Docker + Tailscale

Single-instance personal deployment. One Docker container in an unprivileged
Proxmox LXC, exposed only over the user's tailnet via `tailscale serve`.

## Topology

```
┌──────────────────── tailnet ────────────────────┐
│  user's laptop/phone                            │
│        ↓ https://expenses-host.<ts>.ts.net      │
│  ┌────────── Proxmox host ──────────┐           │
│  │ ┌──────── LXC ─────────────────┐ │           │
│  │ │ tailscaled  ─►  127.0.0.1:4000│ │           │
│  │ │                ↑              │ │           │
│  │ │       docker container        │ │           │
│  │ │       (api + spa)             │ │           │
│  │ │              ↓                │ │           │
│  │ │       /data (bind mount)      │ │           │
│  │ └──────────────────────────────┘ │           │
│  └─────────────────────────────────┘            │
└─────────────────────────────────────────────────┘
```

- **Auth perimeter**: only tailnet devices can reach the URL.
- **Defense in depth**: `REQUIRE_AUTH=true` makes every `/api/*` route also
  require the Microsoft Bearer token the SPA sends after MSAL sign-in.
- **TLS**: `tailscale serve --https=443` issues a cert for the MagicDNS name.

## 1. Provision the LXC

On the Proxmox host (root):

```sh
bash -c "$(curl -fsSL https://raw.githubusercontent.com/community-scripts/ProxmoxVE/main/ct/docker.sh)"
```

This creates an unprivileged LXC with `nesting=1,keyctl=1`, installs Docker
+ Compose, and prints the container ID + IP. Accept defaults unless you have
specific storage/network preferences.

Caveat: Docker-in-unprivileged-LXC is mostly fine on ext4-backed storage. If
overlayfs fights ZFS/btrfs, the script will configure `fuse-overlayfs`
automatically. If issues persist, fall back to a small VM with Docker.

## 2. Join the tailnet

Inside the LXC (`pct enter <id>`):

```sh
curl -fsSL https://tailscale.com/install.sh | sh
tailscale up
```

Follow the printed URL to authenticate the node. Note the MagicDNS name
(e.g. `expenses-host.<your-tailnet>.ts.net`).

## 3. Update the Azure app registration

In the Azure portal → your app registration → **Authentication** → add an
SPA redirect URI:

```
https://expenses-host.<your-tailnet>.ts.net
```

MSAL uses `window.location.origin`, so no SPA code change is needed.

## 4. Clone & configure

```sh
cd /opt
git clone https://github.com/anod/expenses-app.git expenses
cd expenses
cp .env.prod.example .env.prod
# edit .env.prod: set MICROSOFT_CLIENT_ID, ONEDRIVE_WORKBOOK_URL
mkdir -p data data/dumps data/backups
chown -R 1000:1000 data    # match the `node` user inside the container
```

Required edits in `.env.prod`:

- `MICROSOFT_CLIENT_ID` — the SPA client ID from Azure.
- `ONEDRIVE_WORKBOOK_URL` — the share URL of your Excel workbook.
- `WORKSHEET_NAME` — usually `Sheet1`.
- Leave `REQUIRE_AUTH=true` and `SERVE_SPA=true` as shipped.

## 5. Build + run

```sh
docker compose -f compose.deploy.yml up -d --build
docker compose -f compose.deploy.yml logs -f
```

Smoke-check on the LXC:

```sh
curl -s http://127.0.0.1:4000/healthz
curl -s http://127.0.0.1:4000/api/config
```

## 6. Expose via Tailscale Serve

```sh
sudo tailscale serve --bg --https=443 http://127.0.0.1:4000
tailscale serve status
```

Open `https://expenses-host.<tailnet>.ts.net` from any tailnet device. Sign
in with Microsoft when prompted; the SPA will load the forecast page.

**Do not run `tailscale funnel`** unless you intend to expose the app to the
public internet. The default plan keeps the app tailnet-only.

## 7. Backups (local rollback)

The backup script writes an online SQLite snapshot to `/data/backups/`.
Schedule a daily cron on the **LXC host** (not inside the container):

```sh
crontab -e
# add:
0 3 * * * docker exec expenses node /app/apps/api/dist/scripts/backup-db.js
```

Retention defaults to the last 14 files (override with `BACKUP_RETENTION`
in `.env.prod`). To restore: `docker compose -f compose.deploy.yml stop`,
copy the chosen backup over `/data/expenses.db`, then `up -d`.

**Disaster recovery is out of scope here** — `/data/backups` lives on the
same volume as the live DB, so an LXC/disk loss takes both. If you need
real DR, add Proxmox `vzdump`, rsync to a NAS, or restic on top.

## 8. Updates

```sh
cd /opt/expenses
git pull
docker compose -f compose.deploy.yml up -d --build
```

Compose rebuilds the image and replaces the container; the `/data` volume
persists. The migrations runner reapplies any new schema files on boot.

## 9. Demo mode

To show the app to others without exposing real data, run a second instance:

```sh
DEMO_MODE=true PORT=4001 docker compose -p expenses-demo -f compose.deploy.yml \
  up -d --build
```

Or set `DEMO_MODE=true` in `.env.prod` for a single-instance demo. In demo
mode the container uses an in-memory SQLite seeded with funny fake data;
nothing is written to `/data`.

## Troubleshooting

| Symptom | Likely cause | Fix |
| --- | --- | --- |
| Container restarts in a loop | Migration error, bad env | `docker logs expenses` |
| `EACCES` on `/data/*.db` | UID mismatch | `chown -R 1000:1000 data` on the LXC |
| `tailscale serve` shows 502 | App not listening on 4000 | `curl 127.0.0.1:4000/healthz` |
| Sign-in loop | Azure redirect URI mismatch | Add the tailnet URL in Azure |
| Healthcheck reports unhealthy | App took >start_period to boot | Raise `start_period` in compose |

## Files added in Phase 3

- `Dockerfile.app` — multi-stage build (build → prune → runtime).
- `Dockerfile.graph-tester` — renamed Phase-0 file (graph connection test).
- `compose.deploy.yml` — production compose with healthcheck + log rotation.
- `.env.prod.example` — documented production env template.
- `apps/api/src/scripts/backup-db.ts` — online SQLite backup script.
- `apps/api/src/server.ts` — added `SERVE_SPA` static middleware +
  `REQUIRE_AUTH` flag.
- `apps/api/src/config.ts` — `SERVE_SPA`, `SPA_DIR`, `REQUIRE_AUTH` env keys.
