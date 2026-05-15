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

## Run the app (Phase 1)

```bash
npm run dev
```

This spawns the API (`:4000`) and Angular dev server (`:4200`) concurrently.
Open <http://localhost:4200> — the page renders the latest dump as a table:
sticky source/day/label columns, scrollable months, balance row highlighted,
formula cells marked `ƒ`.

## Other scripts

| Command | Effect |
| --- | --- |
| `npm test` | Run all workspace tests (currently `packages/shared` parser tests) |
| `npm run build` | Build all workspaces |
| `npm run test:connection` | Smoke-test the Microsoft Graph connection (no dump) |

## Roadmap

The full plan with all 8 phases is in
[`LLM_IMPLEMENTATION_PLAN.md`](LLM_IMPLEMENTATION_PLAN.md). Phase 1 (this
read-only table fed by a static dump) is complete; Phase 2 swaps the dump
reader for a live Microsoft Graph fetch with token refresh.

## Privacy

`.env`, `.token-cache.json`, and `dumps/` are gitignored. Do not commit them.
The OneDrive sharing URL contains a capability token and is treated as a
secret throughout this repo.
