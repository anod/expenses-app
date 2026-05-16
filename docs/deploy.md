# Deploying to Proxmox LXC via Docker + Tailscale

Single-instance personal deployment. One Docker container in an unprivileged
Proxmox LXC, exposed only over the user's tailnet via `tailscale serve`.

## Topology

```
┌──────────────────── tailnet ────────────────────┐
│  user's laptop/phone                            │
│        ↓ https://expenses.<ts>.ts.net           │
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

## 2. Reach the LXC

The bootstrap script in §4 installs Tailscale and runs `tailscale up`
itself. If you'd rather pre-join the tailnet manually (e.g. to confirm
the hostname before deploying), open a shell into the LXC (`pct enter
<id>`) and run:

```sh
curl -fsSL https://tailscale.com/install.sh | sh
tailscale up --hostname expenses --ssh
```

The `--ssh` flag enables Tailscale SSH so you can `ssh` into the LXC
from any tailnet device without exposing port 22 publicly.

> Pick whatever hostname you like (`expenses`, `cashflow`, `<your-name>-expenses`).
> The MagicDNS FQDN will be `<hostname>.<your-tailnet>.ts.net`.

## 3. Update the Azure app registration

In the Azure portal → your app registration → **Authentication** → add an
SPA redirect URI matching the tailnet hostname you'll give the LXC. For
example, with `TS_HOSTNAME=expenses`:

```
https://expenses.<your-tailnet>.ts.net
```

MSAL uses `window.location.origin`, so no SPA code change is needed.

## 4. One-shot bootstrap

The `scripts/bootstrap-lxc.sh` script installs Tailscale, fetches
`compose.deploy.yml` + `.env.prod.example` straight from GitHub, pulls
the pre-built image from GHCR, brings the stack up, configures
`tailscale serve`, and installs the daily backup cron.

Inside the LXC (`pct enter <id>`):

```sh
curl -fsSL https://raw.githubusercontent.com/anod/expenses-app/main/scripts/bootstrap-lxc.sh \
  | TS_HOSTNAME=expenses bash
```

On first run the script will stop after creating `/opt/expenses/.env.prod`
from the template, so you can fill in:

- `MICROSOFT_CLIENT_ID` — the SPA client ID from Azure.
- `ONEDRIVE_WORKBOOK_URL` — the share URL of your Excel workbook.
- `WORKSHEET_NAME` — usually `Sheet1`.
- Leave `REQUIRE_AUTH=true` and `SERVE_SPA=true` as shipped.

Then re-run the same command; it picks up where it left off (idempotent).

### If the GHCR package is still private

Either flip the package to public in GitHub → Packages → your image →
Settings → Change visibility (recommended for personal use), or pass a
PAT with `read:packages` to the script:

```sh
GHCR_USER=anod GHCR_PAT=ghp_xxx \
  TS_HOSTNAME=expenses \
  bash bootstrap-lxc.sh
```

### Local-build fallback

If you want to build inside the LXC instead of pulling from GHCR (e.g.
testing uncommitted changes), clone the repo and use the build overlay:

```sh
git clone https://github.com/anod/expenses-app.git /opt/expenses
cd /opt/expenses && cp .env.prod.example .env.prod   # edit
mkdir -p data && chown -R 1000:1000 data
docker compose -f compose.deploy.yml -f compose.build.yml up -d --build
```

## 5. Verify

```sh
curl -s http://127.0.0.1:4000/healthz
curl -s http://127.0.0.1:4000/api/config
tailscale serve status
```

Open `https://expenses.<your-tailnet>.ts.net` from any tailnet
device and sign in with Microsoft.

**Do not run `tailscale funnel`** unless you intend to expose the app to
the public internet. The default plan keeps the app tailnet-only.

## 6. Backups (local rollback)

The bootstrap script installs a daily cron at 03:00 UTC that runs
`backup-db.js` inside the container, writing online SQLite snapshots to
`/opt/expenses/data/backups/`. Retention defaults to the last 14 files
(override with `BACKUP_RETENTION` in `.env.prod`).

To restore: `docker compose -f compose.deploy.yml stop`, copy the chosen
backup over `data/expenses.db`, then `up -d`.

**Disaster recovery is out of scope here** — `/data/backups` lives on
the same volume as the live DB, so an LXC/disk loss takes both. If you
need real DR, add Proxmox `vzdump`, rsync to a NAS, or restic on top.

## 7. Updates

Image releases are built automatically by `.github/workflows/build-image.yml`
on every push to `main` and on `v*.*.*` tags, and pushed to
`ghcr.io/anod/expenses-app`. To deploy the latest:

```sh
cd /opt/expenses && bash <(curl -fsSL https://raw.githubusercontent.com/anod/expenses-app/main/scripts/update.sh)
```

Or, if the repo is checked out on the LXC:

```sh
cd /opt/expenses && ./scripts/update.sh
```

The `/data` volume persists across updates; the migrations runner
reapplies any new schema files on boot.

## 8. Demo mode

Demo mode is toggled from the in-app **Settings** page. When on, the API
serves deterministic funny fake data from an in-memory SQLite; the real
`/data/expenses.db` is not touched. The toggle state persists as
`/data/demo-mode.json` so a restart preserves whichever mode you were in
(fake-data edits themselves do not persist).

Use demo mode to show the app to others without exposing real finances,
or to take screenshots. Excel sync is disabled while demo mode is on.

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
- `compose.deploy.yml` — production compose (image from GHCR, healthcheck,
  log rotation).
- `compose.build.yml` — overlay re-enabling a local build.
- `.env.prod.example` — documented production env template.
- `.github/workflows/build-image.yml` — CI that builds and publishes
  `ghcr.io/anod/expenses-app` on every push to `main` and on `v*.*.*`
  tags.
- `scripts/bootstrap-lxc.sh` — one-shot idempotent LXC setup (Tailscale,
  app dir, pull, run, serve, cron).
- `scripts/update.sh` — pull + restart for routine updates.
- `apps/api/src/scripts/backup-db.ts` — online SQLite backup script.
- `apps/api/src/server.ts` — added `SERVE_SPA` static middleware +
  `REQUIRE_AUTH` flag.
- `apps/api/src/config.ts` — `SERVE_SPA`, `SPA_DIR`, `REQUIRE_AUTH` env keys.
