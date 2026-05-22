# Copilot instructions for `expenses`

Small web app around a OneDrive Excel workbook: parses it via Microsoft Graph,
serves it through Express, edits via an Angular PWA. npm workspaces monorepo.

## Workspaces

- `packages/shared` — TypeScript contracts + workbook parser (no runtime deps).
  Imported by both API and web as `@expenses/shared`.
- `apps/api` — Express + Pino, `better-sqlite3` for state, MSAL via Graph.
  Validates bearer tokens with `jose` (JWKS); never stores user tokens.
- `apps/web` — Angular 21 standalone, signals, zoneless, OnPush, `@switch`/`@for`,
  service worker (`ngsw-worker.js`), MSAL.js (auth-code + PKCE), `sessionStorage`.
- `scripts/test-graph-connection.mjs` — device-code MSAL dumper (Phase-0 tooling).

## Commands

Run from the repo root unless noted.

| Task | Command |
| --- | --- |
| Install everything | `npm install` |
| Dev (api :4000 + web :4200, proxied) | `npm run dev` |
| Build all workspaces | `npm run build` |
| Test all workspaces | `npm test` |
| API tests only | `npm run -s test --workspace=apps/api` |
| Shared tests only | `npm run -s test --workspace=packages/shared` |
| Single vitest file | `npm run -s test --workspace=apps/api -- src/auth.test.ts` |
| Single test by name | append `-- -t "pattern"` to a workspace `test` command |
| Dump workbook to `dumps/` | `npm run dump` |
| Import Excel snapshot into SQLite | `npm --workspace @expenses/api run import:excel` |
| SQLite online backup | `npm --workspace @expenses/api run backup:db` |

Web has no test runner wired up; Angular `ng test` is not configured. Don't
add one unless asked.

## Agent workflow

- Always create and work from a dedicated git worktree for each task/session,
  rather than editing the shared checkout directly. This avoids conflicts with
  other local or agent sessions. Use a unique branch/worktree name, and only
  merge/push back to `main` after the task is complete and validated.
- After a task branch is merged to `main`, clean up its dedicated worktree and
  delete the merged local and remote task branches. Prune stale worktree and
  remote-tracking refs as part of the cleanup.

## Architecture (the parts that span files)

- **Two data sources, one API.** `EXPENSES_SOURCE` selects between `dump`
  (reads newest `dumps/dump-*.json` via `dumpReader.ts`) and `graph` (live,
  via `graph/graphClient.ts` + `graph/workbookResolver.ts`). `config.ts` /
  `isGraphConfig()` decides which routes get the bearer guard.
- **Token pass-through.** In graph mode the SPA gets `clientId`/authority/scopes
  from `GET /api/config`, signs in via MSAL popup, and sends `Authorization:
  Bearer <user token>` on every `/api/*` call. The API validates with `jose`
  (`buildBearerGuard` / `requireGraphToken` in `auth.ts`) and forwards the same
  token verbatim to Graph. No server-side token storage; do not introduce any.
- **SQLite as state, not source of truth for the workbook.** `apps/api/src/db`
  uses `better-sqlite3`; schema lives in `apps/api/migrations/NNN-*.sql` applied
  in order by `openDb.ts`. Add new schema as the next-numbered migration; do
  not edit prior ones.
- **Excel import reconciliation.** `apps/api/src/scripts/import-excel.ts` uses
  deterministic IDs prefixed `excel:` for workbook-sourced rows and reconciles
  on re-import (orphan GC at end). Rows with non-`excel:` IDs are user-created
  and must survive re-imports — preserve this when touching the importer.
- **Demo mode.** Toggled from the in-app Settings page; persisted in
  `data/demo-mode.json`. When on, the API serves in-memory fake data through
  `demo/demoController.ts` and `demo/routes.ts` — real DB and workbook are not
  touched. Header shows a `DEMO MODE` badge.
- **Web shell.** `app.config.ts` is zoneless and uses `provideAppInitializer`
  to fetch `/api/config` and initialize `AuthService` before bootstrap; the
  HTTP `authInterceptor` attaches the bearer and retries once on 401 with a
  silent refresh.
- **Forecast / sync / import routes** live in their own folders under
  `apps/api/src/{forecast,sync,import}` and are mounted as `build*Routes()`
  factories from `server.ts`. Follow that factory pattern for new route groups.

## Conventions

- ESM throughout (`"type": "module"`). Relative imports in API/shared use the
  `.js` extension even though the source is `.ts` (NodeNext resolution).
- Logging is Pino with a `redact` list in `server.ts` covering `authorization`,
  `x-ms-graph-token`, `*.accessToken`, `*.refresh_token`, etc. When you log
  request/response data, extend that list rather than logging tokens.
- Config is validated with `zod` in `config.ts`. New env vars go through the
  schema, then `.env.example` (with a comment), then the code that needs them.
- Web prettier: `printWidth: 100`, `singleQuote: true`, HTML parsed as
  `angular` (see `apps/web/.prettierrc`).
- Angular components are standalone with OnPush + signals; templates use
  `@if`/`@for`/`@switch` (not `*ngIf`/`*ngFor`). Follow the existing
  `expenses/expenses-table.ts` style for new feature components.
- Tests use `vitest` (`vitest run` for CI, no jest). Co-locate as
  `*.test.ts` next to the unit under test.

## Privacy / safety

- **Never commit financial data.** `.env`, `.token-cache.json`, `dumps/`,
  `*.xlsx`, `*.db`, and `data/` are gitignored — keep it that way.
- The OneDrive sharing URL contains a capability token and is treated as a
  secret throughout this repo. Don't log it, don't echo it in errors.
- One-off reports/artifacts belong in the session folder
  (`~/.copilot/session-state/<id>/files/`), not in the repo.

## Docs worth reading before non-trivial changes

- `README.md` — overall stack, dev flow, endpoint table.
- `LLM_IMPLEMENTATION_PLAN.md` — 8-phase roadmap; current code is Phase 1+4
  with subsequent phases partially landed (SQLite cache, write-through edits).
- `SETUP_GRAPH.md` — Entra app registration.
- `docs/deploy.md` — Docker image, Proxmox LXC, Tailscale TLS, backups.
