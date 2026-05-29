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

## Chart reference

Use this Vega-Lite definition as the reference layout for projected balance
experiments in the online Vega editor. The x-axis is ordinal by anchor date so
each anchor day appears once instead of using a continuous monthly time scale.
Inline values are sample-shaped data; replace them with forecast anchor rows.

```json
{
  "$schema": "https://vega.github.io/schema/vega-lite/v5.json",
  "description": "Projected balance by anchor period with spending and split credit-card debt as lines.",
  "title": {
    "text": "Projected Balance",
    "subtitle": "Columns show anchor balance; lines show spending and split credit-card debt at each anchor",
    "anchor": "start",
    "fontSize": 16,
    "subtitleFontSize": 12,
    "subtitleColor": "#6b6472"
  },
  "width": 820,
  "height": 320,
  "data": {
    "values": [
      {
        "date": "2026-01-10",
        "anchorBalance": 18400,
        "spendingAtAnchor": 0,
        "splitCcAtAnchor": 0
      },
      {
        "date": "2026-02-10",
        "anchorBalance": 16250,
        "spendingAtAnchor": 3850,
        "splitCcAtAnchor": 900
      },
      {
        "date": "2026-03-10",
        "anchorBalance": 14100,
        "spendingAtAnchor": 4100,
        "splitCcAtAnchor": 1250
      },
      {
        "date": "2026-04-10",
        "anchorBalance": 11950,
        "spendingAtAnchor": 3950,
        "splitCcAtAnchor": 1500
      },
      {
        "date": "2026-05-10",
        "anchorBalance": 9800,
        "spendingAtAnchor": 4200,
        "splitCcAtAnchor": 1750
      },
      {
        "date": "2026-06-10",
        "anchorBalance": 11200,
        "spendingAtAnchor": 3600,
        "splitCcAtAnchor": 1200
      },
      {
        "date": "2026-07-10",
        "anchorBalance": 8700,
        "spendingAtAnchor": 4550,
        "splitCcAtAnchor": 2100
      }
    ]
  },
  "transform": [
    {
      "timeUnit": "yearmonthdate",
      "field": "date",
      "as": "anchorDate"
    }
  ],
  "layer": [
    {
      "mark": {
        "type": "bar",
        "cornerRadiusTopLeft": 4,
        "cornerRadiusTopRight": 4,
        "color": "#d7c8f5",
        "opacity": 0.85,
        "width": 34
      },
      "encoding": {
        "x": {
          "field": "anchorDate",
          "type": "ordinal",
          "title": null,
          "axis": {
            "format": "%b %d",
            "labelAngle": 0,
            "labelFontSize": 12
          }
        },
        "y": {
          "field": "anchorBalance",
          "type": "quantitative",
          "title": "Amount",
          "axis": {
            "format": ",.0f",
            "labelFontSize": 11
          }
        },
        "tooltip": [
          { "field": "date", "type": "temporal", "title": "Anchor", "format": "%b %d, %Y" },
          {
            "field": "anchorBalance",
            "type": "quantitative",
            "title": "Anchor balance",
            "format": ",.0f"
          },
          {
            "field": "spendingAtAnchor",
            "type": "quantitative",
            "title": "Spending @ anchor",
            "format": ",.0f"
          },
          {
            "field": "splitCcAtAnchor",
            "type": "quantitative",
            "title": "Split CC @ anchor",
            "format": ",.0f"
          }
        ]
      }
    },
    {
      "transform": [
        {
          "fold": ["spendingAtAnchor", "splitCcAtAnchor"],
          "as": ["lineKey", "lineValue"]
        },
        {
          "calculate": "datum.lineKey === 'spendingAtAnchor' ? 'Spending @ anchor' : 'Split CC @ anchor'",
          "as": "lineMetric"
        }
      ],
      "mark": {
        "type": "line",
        "strokeWidth": 3,
        "interpolate": "monotone"
      },
      "encoding": {
        "x": {
          "field": "anchorDate",
          "type": "ordinal",
          "title": null
        },
        "y": {
          "field": "lineValue",
          "type": "quantitative"
        },
        "color": {
          "field": "lineMetric",
          "type": "nominal",
          "scale": {
            "domain": ["Spending @ anchor", "Split CC @ anchor"],
            "range": ["#625b71", "#b3261e"]
          },
          "legend": {
            "orient": "top",
            "title": null,
            "labelFontSize": 12,
            "symbolType": "stroke"
          }
        },
        "tooltip": [
          { "field": "date", "type": "temporal", "title": "Anchor", "format": "%b %d, %Y" },
          { "field": "lineMetric", "type": "nominal", "title": "Metric" },
          { "field": "lineValue", "type": "quantitative", "title": "Amount", "format": ",.0f" }
        ]
      }
    },
    {
      "transform": [
        {
          "fold": ["spendingAtAnchor", "splitCcAtAnchor"],
          "as": ["lineKey", "lineValue"]
        },
        {
          "calculate": "datum.lineKey === 'spendingAtAnchor' ? 'Spending @ anchor' : 'Split CC @ anchor'",
          "as": "lineMetric"
        }
      ],
      "mark": {
        "type": "point",
        "filled": true,
        "size": 70,
        "stroke": "white",
        "strokeWidth": 1.5
      },
      "encoding": {
        "x": {
          "field": "anchorDate",
          "type": "ordinal",
          "title": null
        },
        "y": {
          "field": "lineValue",
          "type": "quantitative"
        },
        "color": {
          "field": "lineMetric",
          "type": "nominal",
          "scale": {
            "domain": ["Spending @ anchor", "Split CC @ anchor"],
            "range": ["#625b71", "#b3261e"]
          },
          "legend": null
        },
        "tooltip": [
          { "field": "date", "type": "temporal", "title": "Anchor", "format": "%b %d, %Y" },
          { "field": "lineMetric", "type": "nominal", "title": "Metric" },
          { "field": "lineValue", "type": "quantitative", "title": "Amount", "format": ",.0f" }
        ]
      }
    }
  ],
  "config": {
    "background": "#fffbff",
    "view": {
      "stroke": null
    },
    "axis": {
      "grid": true,
      "gridColor": "#eee8f1",
      "domain": false,
      "tickColor": "#d7d0dd",
      "labelColor": "#49454f",
      "titleColor": "#49454f"
    },
    "legend": {
      "labelColor": "#49454f",
      "orient": "top"
    }
  }
}
```

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
