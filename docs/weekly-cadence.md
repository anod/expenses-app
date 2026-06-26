# Weekly recurring templates with per-occurrence skips

**Status:** PR #1 + PR #2 landed and deployed (`main` @ `8323c66`). PRs #3–#5 pending.

This document captures the design, plan, and current progress for adding
weekly cadence (e.g. a once-a-week therapy session at 205 ILS per meeting)
with the ability to mark individual occurrences as skipped/cancelled.

## How to operate

### Build / test
```sh
npm install              # once
npm run build            # shared → api → web
npm test                 # vitest, all workspaces
npm run -s test --workspace=apps/api
npm run -s test --workspace=packages/shared
```

### Deploy
The image is built by `.github/workflows/build-image.yml` on every push to
`main` and published to `ghcr.io/anod/expenses-app:latest`. To roll the
deployment LXC (SSH target + container/compose path are kept in the
gitignored `.env` as `DEPLOY_SSH`; see `docs/deploy.md`):

```sh
# from a host with SSH access to the LXC (see .env DEPLOY_SSH):
ssh "$DEPLOY_SSH" 'cd /opt/expenses && bash scripts/update.sh'
```

Health probe: `docker logs expenses` should show `API listening` and no
migration errors.

### Database
Schema lives in `apps/api/migrations/NNN-*.sql` and is applied in order on
startup by `openDb.ts`. Never edit prior migrations — add the next
numbered file. Online backup: `npm --workspace @expenses/api run backup:db`.

---

## Design

**User story:** Therapy / lessons / fitness classes that happen on a fixed
weekday (e.g. every Friday) at a per-meeting price (e.g. 205 ILS), billed to
a credit card. Some weeks the session is cancelled, so the monthly bill is
N × price with N ∈ {0..5} per cycle.

**Current behaviour (broken):**
- Excel row "психолог" lives under `[isra]` with monthly totals = N × 205.
- Importer's `partitionRows` rule requires `presentEveryMonth + allEqual`,
  so anything starting mid-year or with even one variable month becomes
  *variable* ledger entries with `date = clampedDate(monthKey, row.day)`.
- That date is then treated as the spend date and routed through the
  card's billing cycle via `firstBillingDayStrictlyAfter`, landing the
  charge on a later bill than the user expects, and giving no way to
  see per-occurrence X/Y progress.

### Plan

**A. Domain model** (`packages/shared/src/types.ts`):

Extend `RecurringTemplate` with a discriminated cadence:
```ts
interface MonthlyCadence { kind: 'monthly'; day: number; monthEndPolicy: 'clamp'; }
interface WeeklyCadence  { kind: 'weekly';  dayOfWeek: 0|1|2|3|4|5|6; }   // 0=Sun
type Cadence = MonthlyCadence | WeeklyCadence;

interface RecurringTemplate {
  id: string;
  description: string;
  amount: Amount;        // per-occurrence amount (per meeting for weekly)
  channel: Channel;
  cadence: Cadence;
  startDate: IsoDate;
  endDate?: IsoDate;
  /** ISO dates the user marked as skipped — occurrence is not generated. */
  skips?: IsoDate[];
}
```
Backwards-compat: keep top-level `day` + `monthEndPolicy` for one release
and synthesize `cadence: { kind: 'monthly', day, monthEndPolicy }` in the
repo loader so existing rows keep working. New writes always set `cadence`.

**B. Pipeline** (`packages/shared/src/forecast/pipeline.ts`):

`expandRecurring()` becomes cadence-aware:
- `monthly`: existing logic (one occurrence per month on clamped day).
- `weekly`: enumerate dates `d` from `startDate` to `min(endDate, horizon)`
  where `d.getDay() === dayOfWeek`, skipping any `skips.includes(d)`.

Each expanded occurrence becomes a `LedgerEntry` with
`occurrenceKey = ${recurringId}@${date}` and `recurringId` set, so the
existing dedup vs persisted ledger entries already works.

Routing into cc bills is unchanged — `firstBillingDayStrictlyAfter` is
called per occurrence date, so 4 Fridays in a billing cycle all roll into
the same bill total.

**C. paymentProgress for weekly** (`paymentProgress.ts`):

Today the helper enumerates monthly anchors. Generalize to take a
cadence: for `weekly`, count Fridays from `startDate` to `endDate`
(excluding skips), and `paid` = count up to `asOf`. Keep the monthly
behaviour identical for existing callers.

**D. Skip UX** (timeline on forecast-home):

Each expanded occurrence row (and each cc-bill sub-row) gets a
"skip / unskip" button when it carries a `recurringId` and a date.
- Skip → PATCH `/api/recurring/:id` adding the date to `skips`.
- Server returns the updated forecast; UI refreshes.
- Past occurrences are read-only (skip would change history; use the
  existing "mark as cleared" instead).

**E. Recurring page form** (`recurring-page.ts/html`):
- Add a cadence picker (Monthly | Weekly).
- Monthly: existing day-of-month picker.
- Weekly: day-of-week picker (Mon..Sun).
- Show count of `skips` as a small badge so users can find/edit them
  (clear-all button in the edit form).

**F. Importer**:
- Keep the current monthly auto-detection unchanged.
- Add a *new* detection branch for weekly-friendly rows: when
  `nonNullValues.length >= 2`, `presentEveryMonth=true`, and every
  present value is a positive integer multiple of some base `b ≥ 1`
  (the GCD), emit a `weekly` template with `amount = b` and
  `dayOfWeek = inferred from row.day` (best-effort: if `row.day` is
  set, treat as the original "anchor day" and find the matching weekday
  of `startDate`; otherwise default to Friday and add a warning).
- Skips are *not* auto-detected on import (would require running the
  weekly expansion against the workbook totals to find under-counts).
  Leave that to the user.
- Add an importer warning when a row's monthly totals don't match any
  N × base (suggests it's actually variable, not weekly).

**G. Migration / data**:
- SQL migration: add `cadence_kind`, `day_of_week`, `skips` (JSON) columns
  to `recurring_template`; backfill `cadence_kind='monthly'` for existing
  rows. Drop `day`/`month_end_policy` columns in a *later* migration once
  all readers use `cadence`.
- No data loss for existing user-created monthly templates.

**H. Tests**:
- `paymentProgress` weekly: count Fridays, skip handling, end-bound.
- Pipeline: weekly template → N occurrences → 1 cc-bill total per cycle.
- Importer: psyche-like row (8 contiguous months × 820 with base 205 →
  detected as weekly Friday 205, startDate=first month-1 Friday).
- Routes: PATCH adds/removes skips; GET returns cadence shape.

**I. Out of scope (defer):**
- Bi-weekly / nth-weekday-of-month cadences.
- UI to bulk-shift skipped dates.
- Auto-skip detection on import.

### Revisions after rubber-duck critique

**Adopt as blocking (will be in the spec):**

- **Skip precedence (#1):** `skips[]` must filter *both* virtual occurrences
  and persisted ledger rows that share `occurrenceKeyOf(id,date)`. The skip
  API also deletes any *pending* persisted override for that occurrence; if
  a *cleared* row exists, return `409 SKIP_CONFLICT_CLEARED` with a flag
  the UI can use to either confirm-and-delete or back off. Test matrix:
  skip ∪ {none, pending override, cleared override} × {skip, unskip}.
- **DB migration (#2):** rebuild `recurring_template` so `day` is nullable,
  add `cadence_kind TEXT NOT NULL CHECK IN ('monthly','weekly')`,
  `day_of_week INTEGER NULL CHECK (day_of_week BETWEEN 0 AND 6)`,
  `skips TEXT NULL` (JSON array, validated at the repo boundary; stored
  sorted/deduped). CHECK constraints: monthly ⇒ `day NOT NULL AND
  day_of_week IS NULL`, weekly ⇒ `day_of_week NOT NULL AND day IS NULL`.
- **Importer preserves user skips (#3):** before upserting an Excel-owned
  template, read existing row by deterministic id and carry `skips` over.
  Orphan GC stays as-is (it only fires when the row truly disappeared).
- **No auto-weekly detection (#4):** importer is unchanged for ambiguous
  rows — they stay variable. Conversion is an *opt-in UI action* on the
  recurring page: "Convert to weekly", asking for `baseAmount` and
  `dayOfWeek`. This drops the GCD heuristic entirely.
- **Single canonical shape (#6):** new `RecurringTemplate` is the
  discriminated `cadence` union; the DB columns are storage-only and live
  inside `StateRepo` mapping. Drop the dual top-level `day`/`monthEndPolicy`
  carrier from the shared type. Migration backfills `cadence_kind='monthly'`
  for existing rows; readers/writers all use the new shape on day one.
- **Dedicated skip endpoints (#7):**
  `POST /api/recurring/:id/skips/:date` and
  `DELETE /api/recurring/:id/skips/:date`.
  Validate that `date` falls on `dayOfWeek` and is within `[startDate,
  endDate ?? horizonEnd]`. Generic PATCH stays for description/amount edits
  only; explicitly *rejects* `skips` in its body.
- **Skip eligibility uses snapshot cutoff (#8):** allow skip/unskip while
  `occurrenceDate > (channel === 'bank' ? account.asOf : card.asOf)`.
  Already-snapshotted occurrences are read-only; use the existing
  "mark as cleared" instead.
- **Timeline metadata plumbing (#9):** carry `recurringId`, `occurrenceKey`,
  and `skipped` onto every `ChargeItem` *and* `BilledChargeRow`. This also
  fixes the bug introduced in the X/Y wiring just shipped — bank virtual
  charges currently resolve `recurringId` via `this.ledger().find(...)`,
  which never matches a virtual entry. Source it from the pipeline output
  instead by extending `ProjectionCharge.source` (kind: 'ledger') with the
  optional `recurringId`/`occurrenceKey` fields from the underlying entry.
- **UTC weekday math (#11):** use `Date.UTC(y, m-1, d).getUTCDay()` (or a
  new `weekdayOfIso` in `forecast/dates.ts`) so DST/timezone never shifts
  a Friday template to Thursday. Settings.timezone is irrelevant for
  date-only fields.

**Adopt as design clarification (not behaviour change):**

- **paymentProgress with skips (#5/#10):** "paid" = count of non-skipped
  occurrences in `[startDate, asOf]`; "total" = count of non-skipped
  occurrences in `[startDate, endDate]`. Open-ended weekly (no `endDate`)
  → returns `null` and no badge on timeline. A separate
  `cycleProgress(template, billDate, card)` helper for "2/4 this bill
  cycle" is **out of scope for v1**; document in §I.

**Defer / scope notes:**

- **Excel sync/export (#5 of critique):** writing weekly templates back
  into the anchor sheet is **out of scope for v1**. `excelWriter` will
  group weekly occurrences into anchor-period totals on render (already
  works correctly because pipeline routes per-occurrence), but the
  `# recurring` export sheet will *skip* weekly rows and emit a warning
  (`weekly templates: N excluded from sheet export — not round-trippable
  in the current Excel format`). Followup PR can extend the sheet schema.
- **Scope (#12):** acknowledged — this is **4–5 PRs**, not 2–3:
  1. Model + pipeline + paymentProgress + tests (no UI, no DB write).
  2. DB migration + StateRepo mapping + dedicated skip routes + tests.
  3. Importer: preserve skips on re-upsert; no auto-weekly.
  4. Web: cadence picker on recurring form; "Convert to weekly" action.
  5. Web: skip/unskip button on timeline (incl. ChargeItem metadata
     plumbing fix for recurringId on bank virtuals).

---

## Progress (PRs)

- **PR #1 — shared layer (commit `e104b96`)** — DONE, deployed
  - Discriminated `Cadence` union (monthly | weekly) + optional `skips[]`
    on `RecurringTemplate`.
  - `weekdayOfIso` (UTC). Pipeline expands weekly, filters skips on both
    virtuals and persisted entries, plumbs `recurringId`/`occurrenceKey`
    through `ChargeSource.kind='ledger'`.
  - `paymentProgress(template, asOf)` cadence- and skip-aware.
  - Web: `forecast-home.progressForEntry` resolves recurringId from the
    pipeline (fixes the X/Y badge on bank virtuals). `recurring-page`
    uses `dayOfMonth` helper. `ForecastApi` gains `RecurringWriteBody`.
  - StateRepo synthesises monthly cadence on read; rejects weekly write.
  - Tests: 73 shared + 127 api.

- **PR #2 — DB migration + skip routes (commit `8323c66`)** — DONE, deployed
  - Migration `006-weekly-cadence.sql`: nullable `day`, new `cadence` +
    `day_of_week` columns with discriminated CHECK, `recurring_skip`
    table (cascade-delete).
  - StateRepo: list/upsert handle both monthly and weekly. Skips managed
    via dedicated `addSkip`/`removeSkip`; upsertRecurring intentionally
    leaves the skip table alone (contract for PR #3).
  - `RecurringInput` accepts either the new `cadence` object or the
    legacy flat `day`/`monthEndPolicy` shape.
  - `POST/DELETE /api/recurring/:id/skips/:date`. POST drops pending
    persisted override; returns 409 `SKIP_CONFLICT_CLEARED` on a cleared
    override.
  - Tests: 138 api + 73 shared.

- **PR #3 — importer preserves skips** — TODO
- **PR #4 — web cadence picker + Convert to weekly** — TODO
- **PR #5 — timeline skip/unskip button (asOf cutoff)** — TODO
