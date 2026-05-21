# Expenses

A small webapp around an existing OneDrive Excel workbook. Reads the workbook
through Microsoft Graph, renders it as a table in the browser, and (in later
phases) caches and edits it.

## Stack

- **packages/shared** — TypeScript contracts + workbook parser (vitest).
- **apps/api** — Express + Pino API serving the parsed workbook snapshot.
- **apps/web** — Angular 21 standalone PWA (signals, OnPush, `@switch`/`@for`).
- **scripts/test-graph-connection.mjs** — MSAL device-code flow that dumps
  the workbook used range to `dumps/dump-<timestamp>.json`. Phase-0 tooling.

## Layout

```
.
├── apps/
│   ├── api/      Express server reading the latest dump
│   └── web/      Angular table view
├── packages/
│   └── shared/   Types + parser shared by api and web
├── scripts/      Standalone Graph tooling (auth + dump)
├── dumps/        Workbook dumps (gitignored)
├── .env          Real config (gitignored)
└── .env.example  Documented config template
```

## One-time setup

1. **Register a Microsoft Entra app** — fastest path is
   [`scripts/register-app.sh`](scripts/register-app.sh) (requires `az login`).
   Manual portal steps are in [`SETUP_GRAPH.md`](SETUP_GRAPH.md).
2. `cp .env.example .env` and fill in `MICROSOFT_CLIENT_ID` and
   `ONEDRIVE_WORKBOOK_URL`.
3. `npm install` at the repo root (npm workspaces will install all packages).

## Dump the workbook (Phase 0)

```bash
npm run dump
```

First run prints a device-code URL — sign in with the Microsoft account that
owns the OneDrive file. The refresh token is cached in `.token-cache.json`
so subsequent runs are non-interactive.

The dump lands in `dumps/dump-<ISO-timestamp>.json`.

A Dockerized variant is available too:

```bash
docker compose run --rm graph-tester                     # connection test
docker compose run --rm graph-tester node scripts/test-graph-connection.mjs --dump
```

## Run the app (Phase 1 / Phase 4)

```bash
npm run dev
```

This spawns the API (`:4000`) and Angular dev server (`:4200`) concurrently.
Open <http://localhost:4200>.

The API can run in either of two modes, controlled by `EXPENSES_SOURCE` in
your `.env`:

| Mode  | Source                          | Sign-in required in browser? |
| ----- | ------------------------------- | ---------------------------- |
| `dump` | Latest file under `dumps/`      | No                           |
| `graph` (default) | Live Microsoft Graph | Yes (Sign in with Microsoft) |

Toggle **Demo mode** from the in-app Settings page to swap the live data
for funny in-memory fake data (real DB and workbook are not touched).
A **DEMO MODE** badge appears in the header while it's on. The toggle
state persists across restarts in `data/demo-mode.json`; demo edits
themselves live in memory only.

In **graph mode**, the API exposes `GET /api/config` (clientId, authority,
scopes) which the Angular app fetches at bootstrap to initialize MSAL.js
(auth-code + PKCE). Every `/api/*` request from the browser carries a
`Authorization: Bearer <user token>` header; the API forwards that token
verbatim to Microsoft Graph. **No tokens are stored server-side.**

### Sign-in flow

1. Browser loads `/api/config` → initializes MSAL with the SPA `clientId`.
2. User clicks **Sign in with Microsoft** (popup).
3. MSAL caches the access + refresh tokens in `sessionStorage`.
4. The HTTP interceptor adds `Authorization: Bearer …` to every `/api/*`
   request. On a 401, it forces a silent refresh and retries once.

### Endpoints

| Endpoint | Auth | Notes |
| --- | --- | --- |
| `GET /healthz` | No | Liveness + current source |
| `GET /api/config` | No | `{ source, auth: { clientId, authority, scopes } | null }` |
| `GET /api/expenses` | Bearer (graph mode) | Parsed `WorkbookSnapshot` |
| `GET /api/workbook/status` | Bearer (graph mode) | Workbook metadata only |

Recurring templates support three schedule shapes:

- **Monthly** — exact day-of-month
- **Weekly** — exact day-of-week
- **Monthly prediction** — one projected occurrence per month without an exact
  business day

When syncing back to Excel, only exact monthly day-of-month templates are
round-trippable in the current workbook format. Weekly and monthly-prediction
templates are excluded from the export sheets with a warning.

## Other scripts

| Command | Effect |
| --- | --- |
| `npm test` | Run all workspace tests (shared parser + API graph layer) |
| `npm run build` | Build all workspaces |
| `npm run test:connection` | Smoke-test the Microsoft Graph connection (no dump) |
| `npm --workspace @expenses/api run backup:db` | Online SQLite backup (used by deploy cron) |

## Deployment

Production deployment is covered in [`docs/deploy.md`](docs/deploy.md):
Docker image, Proxmox LXC bootstrap, Tailscale-served TLS, and backups.

## Roadmap

The full plan with all 8 phases is in
[`LLM_IMPLEMENTATION_PLAN.md`](LLM_IMPLEMENTATION_PLAN.md). Phases 1 and 4
(read-only table fed by either a dump or a live Graph fetch with browser
sign-in) are complete; subsequent phases add a SQLite snapshot cache,
write-through editing, and offline support.

## Privacy

`.env`, `.token-cache.json`, and `dumps/` are gitignored. Do not commit them.
The OneDrive sharing URL contains a capability token and is treated as a
secret throughout this repo.
