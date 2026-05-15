# LLM Implementation Plan: Dockerized Excel-Backed Expenses Website

## Goal

Build a Dockerized responsive web application for viewing, analyzing, and editing the existing expenses workbook stored in OneDrive. The original Excel workbook must remain the source of truth and must stay fully compatible with manual Excel usage.

Use the OneDrive workbook URL as the primary data source (configured at runtime via `ONEDRIVE_WORKBOOK_URL` in `.env`; the URL is a sharing capability token and must not be committed).

## Key Requirement

Do not rewrite the Excel file as a whole. Use Microsoft Graph Excel APIs to read and update workbook ranges/cells so that formulas, formatting, worksheets, metadata, and normal Excel compatibility are preserved.

Avoid using local `.xlsx` writers such as `xlsx`, `exceljs`, or `openpyxl` for production writes unless the user explicitly accepts compatibility risk.

### Formula & Layout Invariants (from live data)

These are non-negotiable, learned from inspecting the actual workbook:

1. **The balance row (`счет`) is computed by Excel.** Cells Jun-onward are `=SUM(D2:D24)` formulas. The app must:
   - Treat balance-row cells as **read-only** in the UI by default.
   - **Never** PATCH a formula cell unless the user explicitly opts in with a "replace formula" confirmation.
2. **Sentinel rows exist below the used range (rows 23-24).** The SUM formulas reach row 24 so the user can add up to two more expense rows without rewriting formulas. If the app ever appends rows it must:
   - Insert **above row 24**, never after, so SUM picks them up.
   - Or, if more than two new rows are needed, extend the SUM range explicitly.
3. **User-authored amount formulas exist** (e.g. `=-308-395`, `=-205*2`). The Graph adapter must read the `formulas` array alongside `values` and surface `isFormula` to the UI. Editing such a cell prompts the user before overwriting.
4. **Currency and locale come from the workbook itself.** Read `numberFormat` from the balance row and use it to drive UI rendering (₪ in this workbook). Do not hardcode the currency symbol in the app.

## Existing Data Shape

> Validated against a live Microsoft Graph dump of the workbook on 2026-05-15.
> Used range: `Sheet1!A1:L22` (22 rows × 12 cols). See `dumps/dump-*.json`.

### Columns

| Col | Header | Meaning |
|----:|--------|---------|
| 0 (A) | `source` | Account/card identifier: `""` (cash/personal), `cal`, `onezero`, `isra`. |
| 1 (B) | `day` | Day of month the recurring charge falls on (1–31), or blank. |
| 2 (C) | `-` | Free-text label, mixed Russian / Hebrew / English. May contain trailing whitespace. |
| 3 (D) … 11 (L) | `10-May-26`, `10-Jun-26`, … `10-Jan-27` | Month columns. Headers are returned by Graph as **strings**, not Excel date serials. |

### Rows

- **Row 0**: header row.
- **Row 1**: balance row (`счет` = "account"). **Special**:
  - May (col 3) is a literal starting balance (`29900`).
  - Jun-Jan (cols 4-11) are **formulas**: `=SUM(D2:D24)`, `=SUM(E2:E24)`, … `=SUM(K2:K24)`.
  - **The SUM range extends to row 24**, two rows past the used range. The author has reserved sentinel rows 23-24 so new expenses can be appended without rewriting the formula.
- **Rows 2-21**: 20 expense / income rows. A few cells contain user-authored arithmetic formulas:
  - `cal debt` row — `=-308-333-395`, `=-308-395` (component breakdown).
  - `психолог` May — `=-205*2`.
- **Row 7 "карта остаток"** (card remainder) is a manually-maintained balance-like row (no formula, but logically a derived running balance from row 6 "карта потрачено"). Treat as a second class of derived row in insights.
- **Row 18 "вода"** (water) follows a **bimonthly pattern**: `["", -132, "", -132, …]`. This is intentional, not missing data.

### Cell Value Conventions

- Empty cells are returned as the empty string `""`. Parser must coerce `""` → `null`.
- Numeric cells return as JS `number`.
- Income is positive; expenses are negative; zero is meaningful (e.g. month not yet active).
- The workbook's currency is **Israeli Shekels (₪ / ILS)**. Detected from the balance row's `numberFormat`: `[$₪-he-IL] #,##0;[Red][$₪-he-IL] -#,##0`. Negative values render in red.

### Normalized Internal Record

```json
{
  "rowIndex": 5,
  "columnIndex": 5,
  "source": "cal",
  "day": 2,
  "label": "cal debt",
  "month": "2026-06-10",
  "amount": -1036,
  "isFormula": true,
  "formula": "=-308-395"
}
```

`rowIndex` and `columnIndex` are required so edits write back to the exact original Excel cell. `isFormula` and `formula` are required so the UI can warn before replacing user-authored arithmetic with a literal.

## Complexity Budget

Keep the dependency surface small and the architecture boring. Rules:

- Pick libraries with long-term stability and small APIs. Avoid frameworks that own the application structure (e.g., NestJS, Next.js) unless they pay for themselves.
- Add a dependency only when a plain function or ~50 lines of code would clearly be worse.
- No database, no cache, no message queue until measurably needed.
- Prefer plain TypeScript modules and functions over classes, decorators, and DI containers.
- One way to do each thing. If two libraries solve the same problem, pick one.

## Recommended Stack

Bias: minimal dependencies, long-lived ecosystems, no framework lock-in beyond Angular itself.

- **Frontend**: Angular (standalone components), TypeScript. Use Angular's built-in component-scoped CSS — no Tailwind, no Angular Material. A small global stylesheet for design tokens (colors, spacing) is enough.
- **Backend**: Node.js + TypeScript + **Express** (or Fastify). No NestJS — too much framework for ~6 endpoints. A handful of route handlers calling adapter functions is sufficient.
- **Shared library**: `packages/shared` — plain TypeScript package (no build step beyond `tsc`) containing API contracts, DTOs, validators, parsers, and calculations. Consumed via npm workspaces.
- **Excel access**: Microsoft Graph REST API via `fetch` (no SDK needed) + `@azure/msal-node` for OAuth token handling.
- **Charts**: Chart.js (used directly via a thin Angular wrapper component, ~30 lines). No `ng2-charts`, no ECharts.
- **PWA**: `@angular/pwa` (built into Angular CLI) for manifest + service worker.
- **Local cache (SQLite)**: a single embedded SQLite file via `better-sqlite3` for fast reads and offline-tolerant loading. The workbook in OneDrive remains the source of truth; SQLite mirrors it. No Redis, no separate DB server.
- **Containerization**: Docker + Docker Compose. Web served as static files via nginx.
- **Refresh tokens**: stored encrypted in the same SQLite file (single table). No separate secret store needed for personal use; in prod, the SQLite file itself lives on an encrypted volume.

## Architecture

```text
packages/shared          (contracts, DTOs, validators, calculations)
  ↑              ↑
  |              |
Angular PWA    NestJS Backend API
(Browser/Mobile)    |
  |                 | Microsoft Graph OAuth + Excel API
  | HTTP / JSON     v
  +------------> OneDrive Excel Workbook
```

### Monorepo Structure

```text
packages/
  shared/            # Shared TypeScript library (contracts, types, validators, calculations)
    src/
      contracts/     # API request/response interfaces, DTOs
      validators/    # Shared validation (cell bounds, numeric parsing)
      calculations/  # Summary, anomaly detection, savings rate
      parsers/       # Expense row normalization logic
    package.json
    tsconfig.json

apps/
  api/               # Express backend
    src/
      server.ts      # Express app + route registration
      routes/        # Thin handlers per endpoint
      excel/         # Graph adapter functions (no classes needed)
      auth/          # MSAL token acquisition + refresh
    Dockerfile
  web/               # Angular PWA frontend
    src/
      app/
        dashboard/
        expenses/
        insights/
        sync/
      ngsw-config.json   # Service worker config for PWA
    Dockerfile
```

The backend owns all Graph access. The frontend must never receive Microsoft client secrets.

### Shared Package (`packages/shared`)

This package is the single source of truth for:

- **API contracts**: request/response interfaces for all endpoints (e.g., `ExpenseCellPatchRequest`, `ExpensesResponse`, `SummaryResponse`).
- **DTOs and types**: `ExpenseRow`, `MonthColumn`, `WorkbookMeta`, etc.
- **Validation logic**: cell boundary checks, numeric parsing rules, batch payload validation.
- **Calculation functions**: monthly income/expenses/net, savings rate, anomaly detection.
- **Parser utilities**: month header detection, CSV row normalization.

Both `apps/api` and `apps/web` depend on `packages/shared` via TypeScript path aliases or npm workspace linking. Changes to contracts are immediately visible to both sides, preventing drift.

## Authentication and Configuration

Use Microsoft identity platform OAuth.

Environment variables:

```env
MICROSOFT_CLIENT_ID=
MICROSOFT_CLIENT_SECRET=
MICROSOFT_TENANT_ID=consumers
ONEDRIVE_WORKBOOK_URL=
GRAPH_REDIRECT_URI=http://localhost:3000/auth/callback
SESSION_SECRET=
```

For a personal OneDrive account, use Microsoft account-compatible app registration settings. Store the refresh token in a single encrypted JSON file on disk for dev; in production, inject via env or secret store. No database required.

## Backend API

Implement these endpoints:

```text
GET  /api/workbook/status
GET  /api/expenses
GET  /api/summary
PATCH /api/expenses/cell
POST /api/expenses/batch
POST /api/workbook/refresh
```

### `GET /api/expenses`

Returns parsed workbook data:

```json
{
  "workbook": {
    "id": "...",
    "worksheet": "Sheet1",
    "range": "A1:L22",
    "lastModifiedDateTime": "..."
  },
  "months": [
    { "key": "2026-05-10", "label": "10-May-26", "columnIndex": 4 }
  ],
  "rows": [
    {
      "rowIndex": 6,
      "source": "cal",
      "day": 2,
      "label": "cal debt",
      "values": {
        "2026-05-10": 0,
        "2026-06-10": -1036
      }
    }
  ]
}
```

### `PATCH /api/expenses/cell`

Updates one amount or metadata cell.

Request:

```json
{
  "rowIndex": 6,
  "columnIndex": 5,
  "value": -1036,
  "expectedWorkbookLastModified": "..."
}
```

Behavior:

- Validate row and column boundaries.
- Validate numeric amount values.
- Check workbook conflict using last modified time or workbook session state.
- Write only the target cell/range through Microsoft Graph.
- Return updated parsed data or the updated cell.

### `POST /api/expenses/batch`

Updates multiple cells in one operation. Prefer batching to reduce Graph calls.

Request:

```json
{
  "changes": [
    { "rowIndex": 6, "columnIndex": 5, "value": -1036 },
    { "rowIndex": 6, "columnIndex": 6, "value": -703 }
  ],
  "expectedWorkbookLastModified": "..."
}
```

## Excel Adapter Requirements

A small set of plain functions (no classes/DI) in `apps/api/src/excel/`:

```text
graphClient.ts        # fetch wrapper with auth header + retry
workbookResolver.ts   # OneDrive URL → driveItem id (cached in memory)
readExpenses.ts       # GET used range, return raw cell grid
writeCells.ts         # PATCH one or more ranges
```

Parsing and normalization live in `packages/shared/parsers/` and are reused by the API and by the local-CSV dev mode.

Responsibilities:

1. Resolve the OneDrive sharing URL to a Graph DriveItem (once at startup; cache result in memory).
2. Read the used range from the target worksheet via Graph.
3. Detect month columns from row 1 starting at column 4 (logic in shared package).
4. Parse numeric cells: blank stays `null`; strip currency symbols / commas; invalid cells reported as validation issues.
5. Preserve row/column coordinates for exact write-back.
6. Write only changed cells/ranges. Use Graph batch endpoint when multiple cells change in one request.
7. Only open a workbook session if/when batch writes get slow — start without sessions.

## UI Requirements

Build a responsive Angular PWA with these screens:

1. Dashboard
   - Current/projected balance (read from the workbook's balance row, never recomputed by us — Excel owns it).
   - Monthly income, expenses, and net (computed by us, excluding the balance row).
   - Savings rate.
   - Top recurring expenses.
   - Balance and monthly net charts (Chart.js via a thin wrapper component).

2. Expense Table
   - Desktop: spreadsheet-like grid rendered with a plain `<table>` and CSS grid. No virtual scroll — the workbook has tens of rows.
   - Mobile: responsive card layout grouped by month or expense, optimized for touch.
   - Inline editing for literal numeric cells.
   - **Formula cells** are visually distinct (e.g. small `ƒ` badge), read-only by default; clicking shows the formula and offers an explicit "replace with literal" action.
   - **Balance row** is rendered with a distinct style and is non-editable.
   - Save/discard state for pending edits.
   - Highlight income (green), expenses (red), zeros, blanks, and changed cells.
   - **Internationalization**: labels in Russian, Hebrew, and English coexist. Use a Unicode-safe font stack; render Hebrew labels with `dir="auto"` so RTL strings display correctly.
   - **Currency**: read `numberFormat` from the workbook's balance row; format amounts using `Intl.NumberFormat` with the detected currency code (`ILS` here). Do not hardcode `₪`.

3. Insights
   - Largest monthly expenses.
   - Expense rows that vary month to month (excluding intentional periodic patterns).
   - Blank cells in otherwise recurring rows (with periodic-pattern detection so bimonthly bills don't false-positive).
   - One-time or temporary expenses.
   - Month-over-month net change.
   - **Derived rows**: surface manually-maintained "остаток" / "remainder" rows alongside the related "spent" row.

4. Sync/Error State
   - Last loaded time.
   - Last workbook modified time.
   - Conflict warning if Excel was changed after the page loaded.
   - Clear messages for Microsoft auth or Graph API failures.

## PWA / Mobile Web App Requirements

The Angular frontend must be configured as a Progressive Web App:

- `@angular/pwa` schematics for service worker and manifest.
- App manifest with name, icons, theme color, and `"display": "standalone"`.
- Service worker caching strategy: cache API responses briefly for offline resilience, always revalidate on reconnect.
- Responsive breakpoints: mobile-first design, usable from 320px width.
- Touch-friendly controls: adequate tap targets, swipe gestures where appropriate.
- Installable on iOS (Add to Home Screen) and Android (install prompt).
- No native wrapper or Capacitor needed — pure web PWA.

## Angular Best Practices (Applied to This Project)

Sourced from the official Angular style guide and AI/LLM guidelines at angular.dev. These are the rules implementation should follow.

### Components

- **Standalone components only.** No NgModules. Do not set `standalone: true` explicitly — it is the default in Angular v20+.
- **`ChangeDetectionStrategy.OnPush`** on every component.
- **Signals for state.** Use `signal()` for local state, `computed()` for derived state, `input()` / `output()` / `model()` functions instead of the legacy decorators.
- Mark properties initialized by Angular (`input`, `output`, `model`, queries) as `readonly`.
- Use `protected` for members only used by a component's template; `private` for purely internal members. Reserve `public` for genuine external APIs.
- Keep components small and presentation-focused. Move parsing, validation, and calculation into `packages/shared` (already planned).
- Prefer inline templates for small components; external `.html` / `.css` files for larger ones, with matching filenames (`dashboard.ts`, `dashboard.html`, `dashboard.css`).
- Group Angular-specific members (injected deps, inputs, outputs, queries) at the top of the class, methods below.

### Templates

- Use native control flow: `@if`, `@for`, `@switch`. **Do not** use `*ngIf`, `*ngFor`, `*ngSwitch`.
- Use `class` and `style` bindings. **Do not** use `ngClass` / `ngStyle`.
- Use the `async` pipe to render observables; do not manually subscribe in components.
- Keep template expressions simple. Move non-trivial logic into `computed()` signals.
- Put host bindings inside the `host` object of `@Component`. **Do not** use `@HostBinding` / `@HostListener`.

### Dependency Injection

- Use the `inject()` function, not constructor parameter injection.
- Services use `@Injectable({ providedIn: 'root' })` for singletons.
- Each service has a single responsibility (e.g., `ExpensesApiService`, `WorkbookStatusService`, `PendingEditsService`).

### Forms

- Use **Reactive Forms** for inline cell editing (typed `FormControl<number | null>`). Avoid template-driven forms.

### State Management

- Signals for everything — no NgRx, no RxJS-heavy stores. The dataset is small and mostly read-only between edits.
- A single `ExpensesStore` service exposing `signal`s for `rows`, `months`, `workbookMeta`, plus `computed` summaries. Pending edits live in a separate `pendingEdits = signal<Map<CellKey, number | null>>()`.
- Keep transformations pure; never `mutate` signals — use `set` or `update`.

### Project Structure (Angular side)

Aligns with style guide "organize by feature area":

```text
apps/web/src/
  main.ts
  app/
    app.ts
    app.routes.ts
    dashboard/
      dashboard.ts
      dashboard.html
      dashboard.css
    expenses/
      expenses-table.ts
      expense-row-card.ts            # mobile card
      pending-edits.service.ts
    insights/
    sync/
    shared-ui/                       # presentational components only
    core/
      expenses-api.service.ts        # HTTP client wrapping shared contracts
```

- File names hyphenated, lowercase, matching the TS identifier (`expenses-table.ts` for `ExpensesTable`).
- Tests sit next to source: `expenses-table.spec.ts`.
- Avoid generic buckets like `components/`, `services/`, `utils/`.

### Routing & Performance

- **Lazy-load feature routes** (`loadComponent: () => import('./insights/insights')`). Dashboard can be eager since it's the landing route.
- Use `NgOptimizedImage` for any static images (icons, illustrations). Note: not for inline base64.
- Provide `HttpClient` via `provideHttpClient(withFetch())` for SSR-compatibility and smaller bundle.

### Accessibility

- Must pass AXE checks and WCAG AA: focus management, color contrast, ARIA attributes.
- Inline-edit cells need accessible labels and keyboard navigation (arrow keys, Enter to commit, Esc to cancel).

### TypeScript

- `strict: true` in `tsconfig`. Prefer type inference; avoid `any` — use `unknown` when truly unknown.
- Shared contracts in `packages/shared` are imported as types where possible to keep runtime bundle minimal.

### What We Deliberately Skip

- No NgRx / Akita / component store — signals are sufficient.
- No Angular Material / PrimeNG — adds weight; build a handful of small components instead.
- No `@HostBinding` / `@HostListener`, no structural-directive `*` syntax, no `ngClass`/`ngStyle` — all per official guidance.
- No legacy module-based lazy loading — use `loadComponent` with standalone components.

## Caching & Sync Architecture

The workbook in OneDrive is the **source of truth**. The backend keeps a SQLite mirror so the UI loads instantly and tolerates brief Graph outages. Sync is **read-through with background refresh** + **write-through with conflict checks**.

### Storage Layout (SQLite)

Single file at `/data/expenses.db`. Tables:

```sql
CREATE TABLE workbook_meta (
  id              INTEGER PRIMARY KEY CHECK (id = 1),  -- singleton row
  drive_item_id   TEXT NOT NULL,
  worksheet_name  TEXT NOT NULL,
  used_range      TEXT NOT NULL,                       -- e.g. "A1:L22"
  last_modified   TEXT NOT NULL,                       -- Graph lastModifiedDateTime
  etag            TEXT,
  fetched_at      TEXT NOT NULL                        -- when we last refreshed
);

CREATE TABLE cells (
  row_index    INTEGER NOT NULL,
  col_index    INTEGER NOT NULL,
  raw_value    TEXT,                                   -- as returned by Graph
  parsed_value REAL,                                   -- numeric or null
  kind         TEXT NOT NULL,                          -- 'amount'|'label'|'header'|'meta'
  PRIMARY KEY (row_index, col_index)
);

CREATE TABLE pending_writes (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  row_index     INTEGER NOT NULL,
  col_index     INTEGER NOT NULL,
  value         REAL,
  created_at    TEXT NOT NULL,
  attempts      INTEGER NOT NULL DEFAULT 0,
  last_error    TEXT
);

CREATE TABLE auth_tokens (
  id             INTEGER PRIMARY KEY CHECK (id = 1),
  refresh_token  BLOB NOT NULL,                        -- encrypted at rest
  access_token   TEXT,
  expires_at     TEXT
);
```

### Read Path (Stale-While-Revalidate)

1. `GET /api/expenses` reads from SQLite synchronously — always fast (< 5 ms).
2. The response includes `workbook.fetchedAt` and `workbook.lastModified` so the UI can show staleness.
3. If `fetched_at` is older than `CACHE_TTL_SECONDS` (default 60s), the handler **kicks off a non-blocking refresh** and still returns the cached data.
4. `POST /api/workbook/refresh` forces an immediate refresh.

### Refresh Algorithm

1. Call Graph `GET /me/drive/items/{id}` to read `lastModifiedDateTime` + ETag — single cheap call.
2. If unchanged since `workbook_meta.last_modified`, update `fetched_at` only and stop.
3. If changed, call Graph `GET .../workbook/worksheets/{name}/usedRange` and re-populate the `cells` table inside a single transaction.
4. Background refreshes run on a `setInterval` (default 5 minutes) as a safety net, plus on-demand from the SWR read path.

### Write Path (Write-Through with Conflict Check)

1. Client sends `PATCH /api/expenses/cell` or `POST /api/expenses/batch` with `expectedWorkbookLastModified`.
2. Backend compares against `workbook_meta.last_modified`. Mismatch → `409 Conflict` with current data.
3. On match, write to Graph via `PATCH .../range(address='X5:X5')`. On success:
   - Update affected rows in `cells`.
   - Re-read `lastModifiedDateTime` from Graph and update `workbook_meta`.
4. On Graph failure, the write is enqueued into `pending_writes` and the client receives `202 Accepted` with a queued status. A retry worker processes the queue with exponential backoff.

### Offline Behaviour (PWA + Server Queue)

Two layers handle offline:

- **Service worker (frontend)**: caches `GET /api/expenses` and `/api/summary` responses with a stale-while-revalidate strategy. App boots and renders even with no network.
- **Server-side queue (`pending_writes`)**: if Graph is unreachable when the user saves, the API persists the change to SQLite + the queue and acknowledges. The retry worker drains the queue when Graph is back.
- The UI surfaces a clear "pending sync" badge driven by `GET /api/workbook/status` which exposes queue depth.

### Cache Invalidation Triggers

- TTL expiry (read path SWR).
- Periodic background refresh.
- Manual `/api/workbook/refresh`.
- After every successful write (we already know it changed).

### What This Cache Is *Not*

- Not a write log / event store.
- Not a multi-user coordination layer.
- Not a place to store derived data (summaries are computed from `cells` on the fly via `packages/shared`).

## Backend Best Practices (Applied to This Project)

Distilled from the Node.js Best Practices project (goldbergyoni/nodebestpractices) and Microsoft Graph guidance, filtered to what this app actually needs.

### Project Structure

- **3-layer architecture**: `routes/` (HTTP) → `services/` (business logic, sync, cache) → `excel/` and `db/` (adapters). Routes never call Graph or SQLite directly.
- One concern per file. Plain exported functions; classes only when state is genuinely instance-scoped.
- All side-effectful I/O (Graph, SQLite, filesystem) lives behind adapter modules so it can be mocked in tests.

### Configuration

- All config from environment variables, loaded once at startup and **validated with Zod**. Fail fast on missing/invalid config.
- No secrets in code, logs, or error messages. `.env` is gitignored; `.env.example` documents required keys.
- A typed `config` object is exported from `apps/api/src/config.ts` and imported where needed — no re-reading `process.env` throughout the code.

### Input Validation

- Validate every request body, query, and param with **Zod schemas defined in `packages/shared`**. The frontend reuses the same schemas for client-side checks — single source of truth.
- Reject unknown fields. Return `400` with a structured error.

### Error Handling

- **Centralized error middleware** in Express. Routes throw typed errors (`AppError`, `ConflictError`, `GraphError`) and the middleware maps them to HTTP status codes + sanitized JSON.
- Distinguish operational errors (network, validation, conflict) from programmer errors (bugs). Operational → respond cleanly; programmer → log + 500 + let the process restart if invariant broken.
- Use `async/await` everywhere; no unhandled promise rejections. Register `process.on('unhandledRejection')` and `uncaughtException` handlers that log and exit.

### Logging

- **Pino** for structured JSON logging. No `console.log` in production code.
- Log levels: `debug` (dev), `info` (request start/end, sync events), `warn` (retries, conflicts), `error` (failures).
- Each request gets a `requestId` (generated middleware) included in every log line for traceability.
- **Never log secrets, tokens, full request bodies with sensitive data, or PII.**

### Microsoft Graph Client

- One thin `fetch`-based client with:
  - Automatic token refresh via MSAL.
  - **Exponential backoff with jitter** on 429/503; honor `Retry-After` header.
  - Timeout (default 15s) on every call.
  - Request/response logging at `debug`.
- Use `$batch` endpoint when sending multiple cell writes in one user action.
- Open a workbook session only if profiling shows it's needed.

### Idempotency & Concurrency

- Writes accept an optional `Idempotency-Key` header. Backend dedups by key for ~10 minutes (in-memory LRU is fine for single-instance).
- All cache updates and queue mutations happen inside SQLite transactions (`better-sqlite3` is synchronous — easy to reason about).
- Single Node process; if scaling out is ever needed, move queue to a real broker. Not now.

### HTTP & Security

- `helmet` for sensible default headers.
- CORS restricted to the web origin from config.
- Body size limits (`express.json({ limit: '100kb' })`).
- Rate limit auth and write endpoints with `express-rate-limit`.
- HTTPS terminated at nginx / reverse proxy; the Node app trusts `X-Forwarded-*` only when behind a known proxy.

### Lifecycle

- **Health endpoints**:
  - `GET /healthz` — process alive (always 200).
  - `GET /readyz` — checks SQLite open + last-known Graph reachability.
- **Graceful shutdown** on `SIGTERM`/`SIGINT`: stop accepting new requests, drain in-flight, flush logs, close SQLite, exit. Docker compose `stop_grace_period` set accordingly.
- Keep the process single-purpose. Let Docker restart it on crash instead of building in-process supervisors.

### Testing

- **Unit tests** for `packages/shared` (parser, calculations, validators) — fastest, highest value.
- **Integration tests** for the API using an in-memory SQLite and a mocked Graph client. Cover the SWR read path, write-through, conflict, and queue retry.
- **Contract tests**: assert API responses conform to the Zod schemas in `packages/shared` so frontend and backend can't drift.
- A small smoke test runs against a **copy** of the real workbook in CI (never the live one).

### What We Deliberately Skip

- No ORM (Prisma/TypeORM). `better-sqlite3` with hand-written SQL in one `db/` module is simpler and faster for ~4 tables.
- No NestJS / DI container.
- No job queue library (Bull/BullMQ). The `pending_writes` table + a `setInterval` worker is plenty for single-user scale.
- No webhooks / Graph subscriptions initially. Polling on read + periodic refresh covers the use case; webhooks can be added later if latency requires it.
- No multi-process clustering. One Node process; scale vertically or revisit later.



Implement summary calculations from parsed data:

- Monthly income: sum of positive amounts.
- Monthly expenses: sum of negative amounts.
- Monthly net: income + expenses.
- Savings rate: monthly net / income.
- Balance row: detect from label if possible, otherwise allow config.
- Average recurring expense by row.
- Anomaly detection:
  - row has blanks mixed with values;
  - row amount changes across months;
  - unusually high expense compared with row average;
  - negative monthly net.

## Docker Setup

Create:

```text
apps/api/Dockerfile
apps/web/Dockerfile
docker-compose.yml
.env.example
```

Example services:

```yaml
services:
  api:
    build:
      context: .
      dockerfile: apps/api/Dockerfile
    env_file: .env
    ports:
      - "4000:4000"

  web:
    build:
      context: .
      dockerfile: apps/web/Dockerfile
    env_file: .env
    ports:
      - "3000:3000"
    depends_on:
      - api
```

The web Dockerfile produces a static Angular build served by nginx, with PWA headers (cache-control for service worker).

## Testing Plan

Add automated tests for:

1. CSV/export parser compatibility using the current exported file shape.
2. Month header detection.
3. Numeric parsing for commas, currency symbols, blanks, zero, negative values.
4. Summary calculations.
5. Cell coordinate mapping.
6. Batch update payload generation.
7. Conflict handling.

Use a copied test workbook for integration tests against Microsoft Graph. Never run write tests against the user's real workbook by default.

## Phased Implementation Plan

The work is split into incremental phases. Each phase is independently shippable and provides visible value. Do not start a phase until the previous one is working and committed.

### Phase 1 — Read-Only Table from Live Workbook Dump (MVP)

**Goal**: a simple page that loads the dumped workbook JSON (`dumps/dump-*.json`, produced by `scripts/test-graph-connection.mjs`) and renders it as a table. No auth in the API yet, no Graph calls during request handling, no cache, no PWA, no editing.

Scope:

- Monorepo skeleton: `packages/shared`, `apps/api`, `apps/web` with npm workspaces and TS project references.
- `packages/shared`:
  - Types: `MonthColumn`, `ExpenseRow` (with `isFormula`/`formula`), `BalanceRow`, `WorkbookSnapshot`.
  - Parser that takes the raw `usedRange` (values + formulas + numberFormat) and produces a `WorkbookSnapshot`. Honors:
    - `""` → `null`.
    - Balance row detection via SUM-formula heuristic (primary) and label match (fallback).
    - Formula detection per cell.
    - Currency extraction from balance-row `numberFormat` → ISO code (`ILS`) and symbol.
  - Unit tests using the actual dump from `dumps/`.
- `apps/api` (Express + TS):
  - Reads the latest `dumps/dump-*.json` from disk and serves it through `GET /api/expenses`.
  - Pino logging, Zod-validated config, centralized error middleware, `/healthz`.
- `apps/web` (Angular standalone, signals, OnPush):
  - One feature: `expenses/` with a component that fetches `/api/expenses` and renders a plain `<table>`.
  - Visual treatment:
    - Balance row distinct (bold, no input affordance).
    - Formula cells show small `ƒ` badge.
    - Negatives in red, positives in green, blanks visibly distinct from zeros.
    - Cyrillic + Hebrew labels rendered with `dir="auto"`.
    - Currency formatted via `Intl.NumberFormat('he-IL', { style: 'currency', currency: 'ILS' })` driven by the snapshot's currency code.
  - No styling beyond a small global stylesheet + component CSS.
  - `ng serve` proxies `/api` to the Express dev server.

Exit criteria:

- `npm run dev` starts API + web; browser shows the workbook as a styled table that visually matches the desktop Excel structure.
- `npm test` runs shared-package parser tests against the real dump and they pass.

Deliberately out of scope: dashboard, charts, editing, live Graph calls, SQLite, Docker (already done for the tester), PWA.

### Phase 2 — Dashboard & Insights from Local Data

**Goal**: useful read-only analysis on top of the Phase 1 data source.

Scope:

- Shared package: monthly income / expenses / net / savings rate calculations + anomaly detection. Unit tests.
- API: `GET /api/summary` endpoint built on shared calculations.
- Web:
  - Routing with lazy-loaded feature components: `dashboard`, `expenses`, `insights`.
  - Dashboard cards (balance, income, expenses, net, savings rate).
  - Chart.js wrapper component for balance and monthly net.
  - Insights screen (top expenses, varying rows, blanks in recurring rows, anomalies).
- Responsive layout (mobile-friendly card view for the table). Still no Tailwind.

Exit criteria: app is genuinely useful as a read-only analyzer of the local CSV; AXE checks pass on all pages.

### Phase 3 — Dockerize

**Goal**: same app, but reproducible build and one-command run.

Scope:

- `apps/api/Dockerfile` (multi-stage, alpine), `apps/web/Dockerfile` (build + nginx static serve).
- `docker-compose.yml` with `api` and `web` services.
- `.env.example` + Zod-validated env loading.
- Volume mount for the local CSV during dev.

Exit criteria: `docker compose up` serves the Phase 2 app at `http://localhost:3000`.

### Phase 4 — Microsoft Graph Read Integration

**Goal**: replace the local CSV with the live OneDrive workbook, read-only.

Scope:

- Microsoft identity app registration (consumers tenant).
- MSAL-based auth: device-code or auth-code flow; refresh token stored in an encrypted file on disk for now.
- Graph client: `fetch` wrapper, MSAL token injection, exponential backoff with jitter, `Retry-After` honored, 15s timeout.
- `workbookResolver` (OneDrive URL → driveItem id, cached in memory).
- `readExpenses` adapter that pulls the used range and feeds the same shared parser.
- `GET /api/workbook/status` returns workbook metadata.
- `GET /api/expenses` now reads from Graph instead of the CSV.

Exit criteria: with valid credentials, the existing UI shows live workbook data. Without credentials, the API returns a clear actionable error.

### Phase 5 — SQLite Cache with Stale-While-Revalidate

**Goal**: fast loads and resilience to brief Graph outages.

Scope:

- `better-sqlite3` integrated; migrations create `workbook_meta`, `cells`, `auth_tokens`.
- Move refresh-token storage from disk file into encrypted `auth_tokens` row.
- Read path:
  - `GET /api/expenses` serves from SQLite synchronously.
  - If `fetched_at` older than TTL → schedule background refresh, still return cached data.
  - Response includes `fetchedAt` and `lastModified` so UI can show staleness.
- Refresh algorithm: cheap `lastModifiedDateTime` check first; full range read only on change. Single transaction to repopulate `cells`.
- Periodic background refresh on `setInterval` (5 min).
- `POST /api/workbook/refresh` forces immediate refresh.

Exit criteria: first paint after Graph integration is sub-second; pulling network briefly does not break the read flow.

### Phase 6 — Editing (Write-Through + Conflict Detection)

**Goal**: edits made in the app are written safely to the OneDrive workbook.

Scope:

- Shared: Zod schemas for `PATCH /api/expenses/cell` and `POST /api/expenses/batch` (reused on both sides for validation).
- API endpoints with `expectedWorkbookLastModified` conflict check returning `409` on mismatch.
- **Formula-cell guardrail**: `PATCH /api/expenses/cell` rejects writes to cells where the cached `formulas[r][c]` starts with `=`, unless the request includes `replaceFormula: true`. Returns `409` (or `422`) with the existing formula.
- **Balance-row guardrail**: writes to the detected balance row are rejected outright, no override.
- **Append-row support**: when a new expense row is added, insert above row 24 so the SUM formula in the balance row continues to include it. If row 24 would be displaced, extend the SUM range first via Graph.
- Graph writer using single-cell `PATCH` and `$batch` for multi-cell updates.
- Cache is updated transactionally on successful write; `workbook_meta.last_modified` re-read from Graph after each write.
- Web:
  - Inline editing for literal numeric cells (Reactive Forms, typed controls).
  - Formula cells display the formula and require explicit "replace with literal" confirmation.
  - Balance-row cells are visually read-only with no edit affordance.
  - Pending edits tracked in a `pendingEdits` signal; user can save/discard.
  - Conflict UI: clear banner + reload prompt when `409` returned.
- Idempotency-Key support on writes.

Exit criteria: edits round-trip through the UI and appear in the Excel file when opened in desktop Excel; SUM formulas remain intact; concurrent edits surface a conflict warning instead of silently overwriting.

### Phase 7 — Offline Queue & PWA

**Goal**: app loads and accepts edits without network.

Scope:

- Backend: `pending_writes` table + retry worker. If Graph is unreachable on write, persist to queue, return `202 Accepted`. Drain queue on reconnect with exponential backoff.
- `GET /api/workbook/status` exposes queue depth and oldest pending write timestamp.
- Web:
  - `@angular/pwa` schematics: manifest, icons, service worker.
  - Service-worker strategy: stale-while-revalidate for `GET /api/expenses` and `/api/summary`.
  - Sync status badge in the UI driven by `/api/workbook/status`.
  - Mobile polish: tap targets, swipe to reveal actions, install prompt.

Exit criteria: install on phone home screen; open with airplane mode → app loads cached data and queues edits; reconnecting drains the queue.

### Phase 8 — Hardening & Deployment

**Goal**: production-ready.

Scope:

- Integration tests: API with mocked Graph + in-memory SQLite covering SWR read, write-through, conflict, queue retry.
- Contract tests: API responses validated against shared Zod schemas.
- Smoke test in CI against a **copy** of the workbook (never live).
- `helmet`, CORS, body limits, `express-rate-limit` on auth and write endpoints.
- `/readyz` with real dependency checks.
- Graceful shutdown on `SIGTERM`/`SIGINT`.
- Backup of the SQLite file via a small cron-style job (it only contains cache + tokens, so disposable, but tokens are inconvenient to re-acquire).
- Deployment doc: env vars, OAuth app setup, volume layout, restore procedure.

Exit criteria: full CI green, security headers verified, deployment doc walks a fresh machine to a running app.

## Phase Dependency Map

```text
P1 (CSV table)
 └─ P2 (dashboard + insights)
     └─ P3 (Docker)
         └─ P4 (Graph read)
             └─ P5 (SQLite cache)
                 └─ P6 (write + conflict)
                     └─ P7 (offline queue + PWA)
                         └─ P8 (hardening)
```

Each phase strictly depends only on the previous one — no skipping ahead.


## Safety Rules for the Implementing LLM

- Do not hardcode secrets.
- Do not commit `.env` or access tokens.
- Do not overwrite the workbook file.
- Do not change workbook layout unless explicitly requested.
- Keep the Excel workbook as the source of truth.
- Preserve blank cells as blank unless the user edits them.
- Preserve formulas by not writing to formula cells unless explicitly allowed.
- Use a workbook copy for development write tests.

## Open Questions

Before implementation, confirm:

1. Should the app support only the current worksheet layout or future custom layouts too?
2. Should users authenticate with their own Microsoft account, or is this a single-user private app?
3. Should categories/notes be stored in new workbook columns, a hidden sheet, or only in app cache?
4. Should edits be saved immediately per cell or staged and saved in batches?
5. Which language should the UI use: English, Russian, Hebrew, or multilingual?
