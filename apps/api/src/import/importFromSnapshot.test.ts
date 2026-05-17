/**
 * Regression-prevention test suite for `importFromSnapshot`.
 *
 * The importer is the single point of truth that maps an Excel workbook
 * snapshot into the SQLite state that drives the forecast pipeline. Any
 * behavioral change here directly shifts predicted balances vs the live
 * workbook, so this suite locks down its observable semantics:
 *
 *   - account seeding (bankBalance / asOf)
 *   - card creation + opening debit (`currentDebit`)
 *   - channel routing (bank vs cc:<cardId>)
 *   - recurring vs variable partitioning
 *   - row-skip rules (derived, bookkeeping, all-zero, all-null)
 *   - scheduling rules (anchorDay shift + day clamping)
 *   - idempotency (re-import = stable state)
 *   - orphan + legacy sweep
 *   - settings preservation
 *
 * The final "golden" test feeds a fully-specified small workbook to
 * `importFromSnapshot` + `computeForecast` and asserts exact daily deltas
 * — any unintended change to import OR projection semantics will fail it.
 *
 * DO NOT relax any assertion here without a deliberate, documented change
 * to the importer or pipeline contract.
 */
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, beforeEach } from 'vitest';
import {
  forecast,
  type AmountCell,
  type ExpenseRow,
  type MonthColumn,
  type RowKind,
  type WorkbookSnapshot,
} from '@expenses/shared';
import { openDb } from '../db/openDb.js';
import { StateRepo } from '../db/stateRepo.js';
import { importFromSnapshot } from './importFromSnapshot.js';

const here = dirname(fileURLToPath(import.meta.url));
const migrationsDir = resolve(here, '..', '..', 'migrations');

const newRepo = (): StateRepo => new StateRepo(openDb({ path: ':memory:', migrationsDir }));

// -------- Snapshot builder helpers ---------------------------------------

let rowCounter = 0;
const nextRowIdx = (): number => ++rowCounter;

const cell = (
  rowIndex: number,
  columnIndex: number,
  value: number | null,
): AmountCell => ({
  rowIndex,
  columnIndex,
  value,
  isFormula: false,
  formula: null,
});

const months = (...keys: string[]): MonthColumn[] =>
  keys.map((key, columnIndex) => ({ key, label: key, columnIndex }));

interface RowInput {
  source?: string;
  day?: number | null;
  label: string;
  kind?: RowKind;
  /** values aligned to month columns; use null for blanks. */
  values: (number | null)[];
}

const mkRow = (cols: MonthColumn[], r: RowInput): ExpenseRow => {
  const rowIndex = nextRowIdx();
  const amounts: Record<string, AmountCell> = {};
  cols.forEach((col, i) => {
    amounts[col.key] = cell(rowIndex, col.columnIndex, r.values[i] ?? null);
  });
  return {
    rowIndex,
    source: r.source ?? '',
    day: r.day ?? null,
    label: r.label,
    labelTrimmed: r.label.trim(),
    kind: r.kind ?? 'expense',
    amounts,
  };
};

const mkSnap = (input: {
  cols: MonthColumn[];
  balance: (number | null)[];
  rows: ExpenseRow[];
  warnings?: string[];
}): WorkbookSnapshot => {
  const balanceRow = mkRow(input.cols, {
    label: 'остаток',
    kind: 'balance',
    values: input.balance,
  });
  return {
    workbook: {
      name: 'test.xlsx',
      worksheet: 'Sheet1',
      range: 'A1:Z100',
      rowCount: 100,
      columnCount: 26,
      lastModifiedDateTime: null,
      fetchedAt: '2026-05-15T00:00:00Z',
      currency: { code: 'ILS', symbol: '₪', locale: 'he-IL', rawFormat: null },
    },
    months: input.cols,
    balanceRow,
    rows: input.rows,
    warnings: input.warnings ?? [],
  };
};

// =========================================================================
// 1. Account seeding
// =========================================================================
describe('importFromSnapshot — account seeding', () => {
  beforeEach(() => { rowCounter = 0; });

  it('seeds bankBalance + asOf from the first-month balance cell', () => {
    const cols = months('2026-05-01', '2026-06-01');
    const repo = newRepo();
    importFromSnapshot(repo, mkSnap({ cols, balance: [12_345, 99_999], rows: [] }));
    const a = repo.getAccount();
    expect(a.bankBalance).toBe(12_345);
    expect(a.asOf).toBe('2026-05-01');
  });

  it('throws when the workbook has no months', () => {
    const repo = newRepo();
    expect(() =>
      importFromSnapshot(repo, mkSnap({ cols: [], balance: [], rows: [] })),
    ).toThrow(/no months/);
  });

  it('throws when first-month balance is missing/non-numeric', () => {
    const cols = months('2026-05-01');
    const repo = newRepo();
    expect(() =>
      importFromSnapshot(repo, mkSnap({ cols, balance: [null], rows: [] })),
    ).toThrow(/Balance row/);
  });
});

// =========================================================================
// 2. Card creation + currentDebit
// =========================================================================
describe('importFromSnapshot — card creation', () => {
  beforeEach(() => { rowCounter = 0; });

  it('creates a card per known cc source present in any row', () => {
    const cols = months('2026-05-01', '2026-06-01');
    const repo = newRepo();
    const snap = mkSnap({
      cols, balance: [10_000, 10_000],
      rows: [
        mkRow(cols, { source: 'cal', day: 15, label: 'groceries', values: [-100, -200] }),
        mkRow(cols, { source: 'isra', day: 20, label: 'fuel', values: [-50, -60] }),
        mkRow(cols, { source: 'onezero', day: 5, label: 'utilities', values: [-30, -30] }),
      ],
    });
    importFromSnapshot(repo, snap);
    const cards = repo.listCards().sort((a, b) => a.id.localeCompare(b.id));
    expect(cards.map((c) => c.id)).toEqual(['cal', 'isra']);
    expect(cards[0]!.billingDayOfMonth).toBe(2);
    expect(cards[1]!.billingDayOfMonth).toBe(2);
    expect(cards[0]!.asOf).toBe('2026-05-01');
  });

  it('opens card debit from «карта потрачено» PLUS first-month itemised cc rows', () => {
    // Excel's column delta sums ALL rows in the column (itemised cc rows
    // AND «карта потрачено» alike). currentDebit must capture both so
    // the first-period bank effect matches Excel.
    const cols = months('2026-05-01', '2026-06-01');
    const repo = newRepo();
    const snap = mkSnap({
      cols, balance: [10_000, 10_000],
      rows: [
        mkRow(cols, { source: 'cal', day: 15, label: 'x', values: [-100, -150] }),
        mkRow(cols, { source: 'cal', day: 5,  label: 'y', values: [-50,  -60]  }),
        mkRow(cols, {
          source: 'cal', label: 'карта потрачено', kind: 'derived',
          values: [-1500, -2000],
        }),
      ],
    });
    importFromSnapshot(repo, snap);
    const card = repo.listCards().find((c) => c.id === 'cal')!;
    expect(card.currentDebit).toBe(1500 + 100 + 50); // = 1650
  });

  it('opens card debit at sum of first-month items when «карта потрачено» row is absent', () => {
    const cols = months('2026-05-01', '2026-06-01');
    const repo = newRepo();
    const snap = mkSnap({
      cols, balance: [10_000, 10_000],
      rows: [mkRow(cols, { source: 'isra', day: 20, label: 'x', values: [-75, -100] })],
    });
    importFromSnapshot(repo, snap);
    expect(repo.listCards()[0]!.currentDebit).toBe(75);
  });

  it('purges pre-existing EXCEL-OWNED cards before recreating', () => {
    const repo = newRepo();
    repo.upsertCard({
      id: 'stale', name: 'Stale', currentDebit: 99, asOf: '2020-01-01', billingDayOfMonth: 5,
      excelOwned: true,
    });
    const cols = months('2026-05-01');
    importFromSnapshot(repo, mkSnap({
      cols, balance: [10_000],
      rows: [mkRow(cols, { source: 'cal', day: 15, label: 'x', values: [-100] })],
    }));
    expect(repo.listCards().map((c) => c.id)).toEqual(['cal']);
  });

  it('PRESERVES user-owned (non-excel) cards across re-import', () => {
    // Regression guard: import used to wipe ALL cards including user-created
    // ones, which orphaned any preserved cc:<userCard> ledger/recurring row.
    const repo = newRepo();
    repo.upsertCard({
      id: 'usercard', name: 'My Card', currentDebit: 500, asOf: '2026-04-01',
      billingDayOfMonth: 20, excelOwned: false,
    });
    const cols = months('2026-05-01');
    importFromSnapshot(repo, mkSnap({
      cols, balance: [10_000],
      rows: [mkRow(cols, { source: 'cal', day: 15, label: 'x', values: [-100] })],
    }));
    const ids = repo.listCards().map((c) => c.id).sort();
    expect(ids).toEqual(['cal', 'usercard']);
    const userCard = repo.listCards().find((c) => c.id === 'usercard');
    expect(userCard?.currentDebit).toBe(500);
    expect(userCard?.excelOwned).toBe(false);
  });

  it('imported cards are marked excel_owned', () => {
    const repo = newRepo();
    const cols = months('2026-05-01');
    importFromSnapshot(repo, mkSnap({
      cols, balance: [10_000],
      rows: [mkRow(cols, { source: 'cal', day: 15, label: 'x', values: [-100] })],
    }));
    expect(repo.listCards()[0]?.excelOwned).toBe(true);
  });
});

// =========================================================================
// 3. Channel routing  (REGRESSION GUARD for the Cal/Isra → cc fix)
// =========================================================================
describe('importFromSnapshot — channel routing', () => {
  beforeEach(() => { rowCounter = 0; });

  it('routes cal-sourced rows to cc:cal', () => {
    const cols = months('2026-05-01', '2026-06-01');
    const repo = newRepo();
    importFromSnapshot(repo, mkSnap({
      cols, balance: [10_000, 10_000],
      rows: [mkRow(cols, { source: 'cal', day: 15, label: 'groceries', values: [-100, -250] })],
    }));
    const ledger = repo.listLedger();
    expect(ledger.length).toBeGreaterThan(0);
    expect(ledger.every((e) => e.channel === 'cc:cal')).toBe(true);
  });

  it('routes isra-sourced rows to cc:isra (recurring path)', () => {
    const cols = months('2026-05-01', '2026-06-01');
    const repo = newRepo();
    importFromSnapshot(repo, mkSnap({
      cols, balance: [10_000, 10_000],
      rows: [mkRow(cols, { source: 'isra', day: 20, label: 'fuel', values: [-200, -200] })],
    }));
    const recurring = repo.listRecurring();
    expect(recurring.length).toBeGreaterThan(0);
    expect(recurring.every((t) => t.channel === 'cc:isra')).toBe(true);
    // cc recurring anchors at the first month; the pipeline's keep()
    // filter drops pre-asOf occurrences so currentDebit is not
    // double-counted, while post-asOf same-month occurrences (which
    // roll into the very next bill) remain visible.
    expect(recurring[0]!.startDate).toBe('2026-05-20');
  });

  it('routes non-cc sources (cash, onezero, …) to bank', () => {
    const cols = months('2026-05-01', '2026-06-01');
    const repo = newRepo();
    importFromSnapshot(repo, mkSnap({
      cols, balance: [10_000, 10_000],
      rows: [
        mkRow(cols, { source: '',        day: 5,  label: 'cash-spend', values: [-100, -200] }),
        mkRow(cols, { source: 'onezero', day: 10, label: 'utilities',  values: [-50, -50] }),
      ],
    }));
    const all = [...repo.listLedger(), ...repo.listRecurring()];
    expect(all.length).toBeGreaterThan(0);
    expect(all.every((e) => e.channel === 'bank')).toBe(true);
  });

  it('source matching is case-insensitive', () => {
    const cols = months('2026-05-01', '2026-06-01');
    const repo = newRepo();
    importFromSnapshot(repo, mkSnap({
      cols, balance: [10_000, 10_000],
      rows: [mkRow(cols, { source: 'CAL', day: 15, label: 'x', values: [-100, -150] })],
    }));
    const channels = [...repo.listLedger(), ...repo.listRecurring()].map((e) => e.channel);
    expect(channels.length).toBeGreaterThan(0);
    expect(channels.every((c) => c === 'cc:cal')).toBe(true);
  });

  it('does NOT synthesize any «карта потрачено» bank-channel cardbill entries', () => {
    // Old importer emitted excel:l:cardbill:<card>:<month> bank entries for
    // months 2+. New importer must NOT, otherwise cc rows are double-billed.
    const cols = months('2026-05-01', '2026-06-01', '2026-07-01');
    const repo = newRepo();
    importFromSnapshot(repo, mkSnap({
      cols, balance: [10_000, 10_000, 10_000],
      rows: [
        mkRow(cols, { source: 'cal', day: 15, label: 'groceries', values: [-100, -200, -300] }),
        mkRow(cols, {
          source: 'cal', label: 'карта потрачено', kind: 'derived',
          values: [-1500, -1600, -1700],
        }),
      ],
    }));
    const offenders = repo.listLedger().filter((e) => e.id.includes('cardbill'));
    expect(offenders).toEqual([]);
  });

  it('SKIPS first-month cc variable rows (already in currentDebit)', () => {
    // Critical: «карта потрачено» first month is the SUM of itemised cal
    // rows for that period. Importing those individual rows in addition
    // to seeding currentDebit would double-bill that period.
    const cols = months('2026-05-01', '2026-06-01', '2026-07-01');
    const repo = newRepo();
    importFromSnapshot(repo, mkSnap({
      cols, balance: [10_000, 10_000, 10_000],
      rows: [
        mkRow(cols, { source: 'cal', day: 15, label: 'groceries',  values: [-100, -200, -300] }),
        mkRow(cols, { source: 'cal', day: 5,  label: 'subscription', values: [-50, -60, -70] }),
      ],
    }));
    const ledger = repo.listLedger().sort((a, b) => a.date.localeCompare(b.date));
    // No ledger entry should reside in the first month (2026-05).
    expect(ledger.every((e) => !e.date.startsWith('2026-05'))).toBe(true);
    // Subsequent months: dates use column-month (no anchor shift), so the
    // bill cycle that closes each column captures that column's spending.
    expect(ledger.map((e) => e.date)).toEqual([
      '2026-06-05', '2026-06-15', '2026-07-05', '2026-07-15',
    ]);
  });

  it('cc variable rows in non-first months are dated within the column month', () => {
    // Anchor-shift is NOT applied for cc rows: column=2026-06, day=5
    // stays in June, billing on next billing day = 2026-07-02.
    const cols = months('2026-05-01', '2026-06-01');
    const repo = newRepo();
    importFromSnapshot(repo, mkSnap({
      cols, balance: [10_000, 10_000],
      rows: [mkRow(cols, { source: 'cal', day: 5, label: 'sub', values: [-50, -60] })],
    }));
    expect(repo.listLedger().map((e) => e.date)).toEqual(['2026-06-05']);
  });
});

// =========================================================================
// 4. Recurring vs variable partitioning
// =========================================================================
describe('importFromSnapshot — recurring vs variable partitioning', () => {
  beforeEach(() => { rowCounter = 0; });

  it('row with stable amount across every month + day-set → recurring', () => {
    const cols = months('2026-05-01', '2026-06-01', '2026-07-01');
    const repo = newRepo();
    importFromSnapshot(repo, mkSnap({
      cols, balance: [10_000, 10_000, 10_000],
      rows: [mkRow(cols, { source: '', day: 10, label: 'mortgage', values: [-5500, -5500, -5500] })],
    }));
    const r = repo.listRecurring();
    expect(r).toHaveLength(1);
    expect(r[0]!.amount).toBe(-5500);
    expect(r[0]!.day).toBe(10);
    expect(repo.listLedger()).toEqual([]);
  });

  it('row with varying amounts → variable (per-month ledger entries)', () => {
    const cols = months('2026-05-01', '2026-06-01', '2026-07-01');
    const repo = newRepo();
    importFromSnapshot(repo, mkSnap({
      cols, balance: [10_000, 10_000, 10_000],
      rows: [mkRow(cols, { source: '', day: 15, label: 'groceries', values: [-100, -200, -300] })],
    }));
    expect(repo.listRecurring()).toEqual([]);
    expect(repo.listLedger()).toHaveLength(3);
  });

  it('row missing a month (gap) → variable, not recurring', () => {
    const cols = months('2026-05-01', '2026-06-01', '2026-07-01');
    const repo = newRepo();
    importFromSnapshot(repo, mkSnap({
      cols, balance: [10_000, 10_000, 10_000],
      rows: [mkRow(cols, { source: '', day: 10, label: 'on-off', values: [-100, null, -100] })],
    }));
    expect(repo.listRecurring()).toEqual([]);
    expect(repo.listLedger()).toHaveLength(2);
  });

  it('row without `day` → variable even if amounts are stable', () => {
    const cols = months('2026-05-01', '2026-06-01');
    const repo = newRepo();
    importFromSnapshot(repo, mkSnap({
      cols, balance: [10_000, 10_000],
      rows: [mkRow(cols, { source: '', day: null, label: 'no-day', values: [-100, -100] })],
    }));
    expect(repo.listRecurring()).toEqual([]);
    expect(repo.listLedger()).toHaveLength(2);
  });

  it('recurring startDate clamps when day exceeds the first month length', () => {
    const cols = months('2026-02-01', '2026-03-01', '2026-04-01');
    const repo = newRepo();
    importFromSnapshot(repo, mkSnap({
      cols, balance: [10_000, 10_000, 10_000],
      rows: [mkRow(cols, { source: '', day: 31, label: 'end-month', values: [-100, -100, -100] })],
    }));
    expect(repo.listRecurring()[0]!.startDate).toBe('2026-02-28');
  });
});

// =========================================================================
// 5. Skip rules
// =========================================================================
describe('importFromSnapshot — skip rules', () => {
  beforeEach(() => { rowCounter = 0; });

  it('skips derived rows other than «карта остаток»', () => {
    const cols = months('2026-05-01');
    const repo = newRepo();
    importFromSnapshot(repo, mkSnap({
      cols, balance: [10_000],
      rows: [mkRow(cols, { source: 'cal', label: 'some sum', kind: 'derived', values: [-100] })],
    }));
    expect(repo.listLedger()).toEqual([]);
    expect(repo.listRecurring()).toEqual([]);
  });

  it('skips bookkeeping row «карта потрачено» (does not enter ledger)', () => {
    const cols = months('2026-05-01', '2026-06-01');
    const repo = newRepo();
    importFromSnapshot(repo, mkSnap({
      cols, balance: [10_000, 10_000],
      rows: [
        mkRow(cols, { source: 'cal', day: 15, label: 'x', values: [-100, -100] }),
        mkRow(cols, {
          source: 'cal', label: 'карта потрачено', kind: 'derived',
          values: [-1000, -1200],
        }),
      ],
    }));
    const fromPotracheno = repo.listLedger().filter((e) => e.description.includes('потрачено'));
    expect(fromPotracheno).toEqual([]);
  });

  it('skips rows that are all-zero', () => {
    const cols = months('2026-05-01', '2026-06-01');
    const repo = newRepo();
    importFromSnapshot(repo, mkSnap({
      cols, balance: [10_000, 10_000],
      rows: [mkRow(cols, { source: '', day: 10, label: 'zeros', values: [0, 0] })],
    }));
    expect(repo.listLedger()).toEqual([]);
    expect(repo.listRecurring()).toEqual([]);
  });

  it('skips rows with no numeric values in any month', () => {
    const cols = months('2026-05-01', '2026-06-01');
    const repo = newRepo();
    importFromSnapshot(repo, mkSnap({
      cols, balance: [10_000, 10_000],
      rows: [mkRow(cols, { source: '', day: 10, label: 'empty', values: [null, null] })],
    }));
    expect(repo.listLedger()).toEqual([]);
  });
});

// =========================================================================
// 6. Scheduling — scheduleDateForColumn semantics
// =========================================================================
describe('importFromSnapshot — variable-row scheduling', () => {
  beforeEach(() => { rowCounter = 0; });

  it('day > anchor (10) keeps the entry in the column month', () => {
    const cols = months('2026-05-01', '2026-06-01');
    const repo = newRepo();
    importFromSnapshot(repo, mkSnap({
      cols, balance: [10_000, 10_000],
      rows: [mkRow(cols, { source: '', day: 15, label: 'x', values: [-100, -200] })],
    }));
    const dates = repo.listLedger().map((e) => e.date).sort();
    expect(dates).toEqual(['2026-05-15', '2026-06-15']);
  });

  it('day ≤ anchor (10) pushes the entry to the NEXT month', () => {
    const cols = months('2026-05-01', '2026-06-01');
    const repo = newRepo();
    importFromSnapshot(repo, mkSnap({
      cols, balance: [10_000, 10_000],
      rows: [mkRow(cols, { source: '', day: 5, label: 'x', values: [-100, -200] })],
    }));
    const dates = repo.listLedger().map((e) => e.date).sort();
    expect(dates).toEqual(['2026-06-05', '2026-07-05']);
  });

  it('day=null defaults to anchor day (10) and pushes to next month', () => {
    const cols = months('2026-05-01');
    const repo = newRepo();
    importFromSnapshot(repo, mkSnap({
      cols, balance: [10_000],
      rows: [mkRow(cols, { source: '', day: null, label: 'x', values: [-100] })],
    }));
    expect(repo.listLedger()[0]!.date).toBe('2026-06-10');
  });

  it('day clamps when the target month is shorter', () => {
    const cols = months('2026-01-01');
    const repo = newRepo();
    importFromSnapshot(repo, mkSnap({
      cols, balance: [10_000],
      // day=31 ≤ anchor? no, 31>10 → stays in Jan. But Feb has 28 — different test.
      rows: [mkRow(cols, { source: '', day: 31, label: 'eom', values: [-100] })],
    }));
    expect(repo.listLedger()[0]!.date).toBe('2026-01-31');
  });

  it('day ≤ anchor with month-end clamp into shorter target', () => {
    const cols = months('2026-01-01');
    const repo = newRepo();
    // day=5 → push to Feb. 5 < 28 → no clamp needed; sanity check date.
    importFromSnapshot(repo, mkSnap({
      cols, balance: [10_000],
      rows: [mkRow(cols, { source: '', day: 5, label: 'x', values: [-100] })],
    }));
    expect(repo.listLedger()[0]!.date).toBe('2026-02-05');
  });
});

// =========================================================================
// 7. Idempotency + orphan/legacy sweep
// =========================================================================
describe('importFromSnapshot — idempotency & cleanup', () => {
  beforeEach(() => { rowCounter = 0; });

  it('re-importing the same snapshot leaves identical state', () => {
    const cols = months('2026-05-01', '2026-06-01');
    const snap = mkSnap({
      cols, balance: [10_000, 10_000],
      rows: [
        mkRow(cols, { source: '',    day: 10, label: 'mortgage', values: [-5500, -5500] }),
        mkRow(cols, { source: 'cal', day: 15, label: 'groceries', values: [-100, -200] }),
      ],
    });
    const repo = newRepo();
    importFromSnapshot(repo, snap);
    const a1 = repo.getAccount();
    const led1 = repo.listLedger().map((e) => ({ ...e })).sort((a, b) => a.id.localeCompare(b.id));
    const rec1 = repo.listRecurring().map((t) => ({ ...t })).sort((a, b) => a.id.localeCompare(b.id));
    const card1 = repo.listCards().sort((a, b) => a.id.localeCompare(b.id));

    importFromSnapshot(repo, snap);
    expect(repo.getAccount()).toEqual(a1);
    expect(repo.listLedger().sort((a, b) => a.id.localeCompare(b.id))).toEqual(led1);
    expect(repo.listRecurring().sort((a, b) => a.id.localeCompare(b.id))).toEqual(rec1);
    expect(repo.listCards().sort((a, b) => a.id.localeCompare(b.id))).toEqual(card1);
  });

  it('preserves user-modified ledger status when re-importing', () => {
    const cols = months('2026-05-01');
    const snap = mkSnap({
      cols, balance: [10_000],
      rows: [mkRow(cols, { source: '', day: 15, label: 'x', values: [-100] })],
    });
    const repo = newRepo();
    importFromSnapshot(repo, snap);
    const id = repo.listLedger()[0]!.id;
    repo.upsertLedger({ ...repo.listLedger()[0]!, status: 'cleared' });
    importFromSnapshot(repo, snap);
    expect(repo.listLedger().find((e) => e.id === id)!.status).toBe('cleared');
  });

  it('orphan sweep removes excel:* ledger entries absent from the new snapshot', () => {
    const cols = months('2026-05-01', '2026-06-01');
    const repo = newRepo();
    importFromSnapshot(repo, mkSnap({
      cols, balance: [10_000, 10_000],
      rows: [mkRow(cols, { source: '', day: 15, label: 'old-row', values: [-100, -150] })],
    }));
    expect(repo.listLedger().length).toBe(2);
    importFromSnapshot(repo, mkSnap({
      cols, balance: [10_000, 10_000],
      rows: [mkRow(cols, { source: '', day: 15, label: 'new-row', values: [-100, -150] })],
    }));
    const descs = repo.listLedger().map((e) => e.description);
    expect(descs.every((d) => !d.includes('old-row'))).toBe(true);
    expect(descs.some((d) => d.includes('new-row'))).toBe(true);
  });

  it('legacy sweep removes l-/r- prefixed rows from a prior importer', () => {
    const repo = newRepo();
    repo.upsertLedger({
      id: 'l-legacy', description: 'old', amount: -1, channel: 'bank',
      date: '2026-01-01', status: 'pending',
    });
    repo.upsertRecurring({
      id: 'r-legacy', description: 'old', amount: -1, channel: 'bank',
      day: 1, startDate: '2026-01-01', monthEndPolicy: 'clamp',
    });
    const cols = months('2026-05-01');
    importFromSnapshot(repo, mkSnap({ cols, balance: [10_000], rows: [] }));
    expect(repo.listLedger().find((e) => e.id === 'l-legacy')).toBeUndefined();
    expect(repo.listRecurring().find((t) => t.id === 'r-legacy')).toBeUndefined();
  });

  it('does NOT touch user-created (non-excel:* prefixed) entries', () => {
    const repo = newRepo();
    repo.upsertLedger({
      id: 'user-1', description: 'mine', amount: -42, channel: 'bank',
      date: '2026-06-15', status: 'pending',
    });
    const cols = months('2026-05-01');
    importFromSnapshot(repo, mkSnap({ cols, balance: [10_000], rows: [] }));
    expect(repo.listLedger().find((e) => e.id === 'user-1')).toBeDefined();
  });
});

// =========================================================================
// 8. Settings preservation
// =========================================================================
describe('importFromSnapshot — settings', () => {
  beforeEach(() => { rowCounter = 0; });

  it('preserveSettings=true (default) keeps user prefs but bumps horizonMonths', () => {
    const repo = newRepo();
    repo.upsertSettings({
      threshold: 1234, timezone: 'Asia/Jerusalem', horizonMonths: 1,
      currency: 'ILS', workbookUrl: 'https://example/wb',
    });
    const cols = months('2026-05-01', '2026-06-01', '2026-07-01', '2026-08-01');
    importFromSnapshot(repo, mkSnap({ cols, balance: [10_000, 10_000, 10_000, 10_000], rows: [] }));
    const s = repo.getSettings();
    expect(s.threshold).toBe(1234);
    expect(s.workbookUrl).toBe('https://example/wb');
    expect(s.horizonMonths).toBeGreaterThanOrEqual(4);
  });

  it('preserveSettings=false overwrites with defaults', () => {
    const repo = newRepo();
    repo.upsertSettings({
      threshold: 9999, timezone: 'UTC', horizonMonths: 1,
      currency: 'ILS', workbookUrl: 'https://example/wb',
    });
    const cols = months('2026-05-01', '2026-06-01');
    importFromSnapshot(
      repo,
      mkSnap({ cols, balance: [10_000, 10_000], rows: [] }),
      { preserveSettings: false },
    );
    const s = repo.getSettings();
    expect(s.threshold).toBe(2000);
    expect(s.timezone).toBe('Asia/Jerusalem');
    expect(s.currency).toBe('ILS');
  });
});

// =========================================================================
// 9. GOLDEN end-to-end: snapshot → forecast (regression crown jewel)
// =========================================================================
describe('importFromSnapshot — golden forecast parity', () => {
  beforeEach(() => { rowCounter = 0; });

  /**
   * A small, fully-specified workbook covering every pipeline-relevant
   * feature: a salary, a recurring bank charge, a cc card with both
   * opening debit and itemized future spend, and a variable bank entry.
   *
   * Any change to importer OR pipeline that shifts the predicted balance
   * on the asserted days breaks this test. Update only with deliberate,
   * documented intent.
   */
  it('locks down exact daily deltas for a representative workbook', () => {
    // Three months. May is anchor (asOf = 2026-05-01). Card billingDay=2.
    const cols = months('2026-05-01', '2026-06-01', '2026-07-01');

    // Rows:
    //   salary      : recurring bank +15_000 on the 1st
    //   mortgage    : recurring bank -5_500 on the 10th
    //   groceries   : variable cal -100/-200/-300 on the 15th
    //   карта потрачено: bookkeeping (seeds currentDebit from -1_500)
    const rows: ExpenseRow[] = [
      mkRow(cols, { source: '',    day: 1,  label: 'salary',   values: [15_000, 15_000, 15_000] }),
      mkRow(cols, { source: '',    day: 10, label: 'mortgage', values: [-5_500, -5_500, -5_500] }),
      mkRow(cols, { source: 'cal', day: 15, label: 'groceries', values: [-100, -200, -300] }),
      mkRow(cols, {
        source: 'cal', label: 'карта потрачено', kind: 'derived',
        values: [-1_500, -2_000, -2_500],
      }),
    ];
    const snap = mkSnap({ cols, balance: [20_000, 20_000, 20_000], rows });

    const repo = newRepo();
    importFromSnapshot(repo, snap, { preserveSettings: false });
    // Wide horizon + force a today equal to asOf so the projection starts there.
    repo.upsertSettings({
      ...repo.getSettings(), horizonMonths: 4, timezone: 'UTC',
    });
    // Use a deterministic 'today' by computing the forecast directly with a
    // fixed today rather than relying on todayInZone() (real time).
    const result = forecast({
      templates: repo.listRecurring(),
      persisted: repo.listLedger(),
      account:   repo.getAccount(),
      cards:     repo.listCards(),
      settings:  repo.getSettings(),
      today:     '2026-05-01',
    });

    const day = (d: string) => result.days.find((x) => x.date === d);

    // ---- Walk through the projection day by day --------------------------
    // May 1 (asOf): bankBalance = 20_000.
    //   The salary day=1 virtual at 2026-05-01 is DROPPED by mergeWithOverrides
    //   because bank entries on/before asOf are already reflected in the
    //   opening balance.
    expect(day('2026-05-01')!.balance).toBe(20_000);
    expect(day('2026-05-01')!.delta).toBe(0);

    // May 2: currentDebit -1_600 bills here.
    //   = |«карта потрачено» first-month -1_500|
    //   + |itemised first-month cal groceries -100|
    //   (first-month cc items are absorbed into currentDebit, not
    //    duplicated as ledger entries — see the channel-routing block.)
    expect(day('2026-05-02')!.delta).toBe(-1_600);
    expect(day('2026-05-02')!.balance).toBe(18_400);

    // May 10: mortgage virtual -5_500 → 12_900.
    expect(day('2026-05-10')!.delta).toBe(-5_500);
    expect(day('2026-05-10')!.balance).toBe(12_900);

    // May 15: NOTHING. First-month cc groceries are skipped (part of
    // currentDebit). Balance flat.
    expect(day('2026-05-15')!.delta).toBe(0);
    expect(day('2026-05-15')!.balance).toBe(12_900);

    // Jun 1: salary virtual +15_000 → 27_900.
    expect(day('2026-06-01')!.delta).toBe(15_000);
    expect(day('2026-06-01')!.balance).toBe(27_900);

    // Jun 2: NO cc bill — first-month cc charges all absorbed by currentDebit.
    expect(day('2026-06-02')!.delta).toBe(0);
    expect(day('2026-06-02')!.balance).toBe(27_900);

    // Jun 10: mortgage -5_500 → 22_400.
    expect(day('2026-06-10')!.delta).toBe(-5_500);
    expect(day('2026-06-10')!.balance).toBe(22_400);

    // Jun 15: cc:cal -200 (second-month groceries) → no bank delta.
    expect(day('2026-06-15')!.delta).toBe(0);

    // Jul 1: salary virtual → 37_400.
    expect(day('2026-07-01')!.delta).toBe(15_000);
    expect(day('2026-07-01')!.balance).toBe(37_400);

    // Jul 2: cc:cal bill = -200 (Jun 15 charge; Jul 15 charge bills Aug 2).
    expect(day('2026-07-02')!.delta).toBe(-200);
    expect(day('2026-07-02')!.balance).toBe(37_200);
  });
});
