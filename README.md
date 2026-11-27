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

When backing up to Excel, only exact monthly day-of-month templates are
round-trippable in the current workbook format. Weekly and monthly-prediction
templates are excluded from the export sheets with a warning.

### ESOP price simulation

On the **ESOP** page, choose **Simulate prices** to temporarily adjust the USD/NIS
exchange rate and stock price. Totals, grant taxes, and unlock forecasts
recalculate locally as you type; no values are written to the workbook or DB.
Both inputs must be positive numbers. **Reset simulation** or leaving the page
restores saved market values. The market **Update** action is disabled during
simulation to prevent accidental writes.

### Savings pots

A **savings pot** is money you deliberately set aside. A pot gets its own
channel, `savings:<potId>`, alongside `bank` and `cc:<cardId>`.

You create a pot where you'll actually use it: on the **Recurring** page, pick
`+ New savings pot…` in the channel dropdown and name it inline while setting up
the monthly contribution — pay-yourself-first in one step. Once it exists, the
pot appears as a tile on the **Forecast** home page, where you can rename it,
correct its current balance, or delete it. (REST equivalent:
`GET/POST/PATCH/DELETE /api/pots`.)

A contribution is an ordinary ledger entry or recurring template on that
channel with a negative amount: the money **really leaves the bank account**,
so it lowers the projected balance and counts against the safety threshold,
and the same amount is added to the pot. A positive amount is a withdrawal
back into the bank.

Each pot carries its own `balance`/`asOf` snapshot — independent of the bank
snapshot — and the forecast day-walks it forward, returning it as
`ForecastResult.pots[]`. The home page shows a card per pot (saved today vs.
projected at the horizon) and a dashed savings series on the projected-balance
chart. On that chart, contributions also count toward the "Expected spending"
line, so it continues to account for the full drop in the balance. Deleting a
pot also deletes its ledger entries and recurring templates, since an
unresolvable `savings:` channel would break the forecast.

### Additional spending budget

On **Forecast**, edit the **Spending budget** card just like a bank or credit-card
snapshot. Set the extra monthly allowance, the amount still expected this period,
and its end-of-day snapshot date. This is **additional unplanned spending**, not a
cap on bills or a bank balance: it lowers future projected balances and affects
the minimum balance and safety warnings.

The remainder is spread evenly, in cents, over the days after the snapshot
through the next 10th; the final day absorbs rounding. New full periods run from
the 11th through the next 10th and use the monthly allowance. As time passes,
elapsed estimates reduce the displayed remainder, but are not treated as actual
historical bank transactions. Only future allocations reduce the bank forecast.
Update the remaining amount when recording real spending; scheduled ledger
outflows, credit-card bills, and savings contributions remain separate.

Each dated timeline anchor shows the balance before the allowance, with the
final balance after the allowance directly beneath it beside a colored wallet
icon. The final balance matches the chart and includes the allowance only once;
there are no separate budget or period calculation rows. Credit-card bill
breakdowns are not counted again. Expected spending totals cover all channels;
partial first/last periods include only forecast dates. Predictions
cannot be cleared or skipped as ledger transactions.

Desktop snapshot cards have matching sizes. On mobile, **Bank / CC / Budget**
share one compact row; tapping a pill expands its details, and tapping again
collapses them. Only one group is open at a time. Switching groups cancels unsaved
snapshot edits. Use **Disable** in the budget editor to remove the allowance.
Timeline filters use a single compact text-only row on mobile.
Compact mobile savings-pot cards show today's saved balance, not the end-of-horizon
projection. Desktop cards show both amounts with their labels.

Budget settings persist in SQLite through `PATCH /api/settings`
(`spendingBudget: { monthlyAllowance, remaining, asOf }`; null disables it).
Amounts must be nonnegative whole cents and the snapshot date cannot be in the
future. Omitting the field preserves it. In demo mode, changes remain in memory
and never affect the real DB or Excel workbook.

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
