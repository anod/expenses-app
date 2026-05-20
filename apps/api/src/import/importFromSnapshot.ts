/**
 * Excel → SQLite importer (reusable from CLI and API).
 *
 * Accepts a parsed `WorkbookSnapshot` and a `StateRepo`, applies the
 * idempotent import described in `apps/api/src/scripts/import-excel.ts`,
 * and returns a summary. See that file's header comment for semantics.
 */
import type {
  Channel,
  ExpenseRow,
  LedgerEntry,
  RecurringTemplate,
  CreditCard,
  WorkbookSnapshot,
} from '@expenses/shared';
import type { StateRepo } from '../db/stateRepo.js';

const CREDIT_CARD_SOURCES: Record<string, { name: string; billingDay: number }> = {
  cal: { name: 'Cal', billingDay: 2 },
  isra: { name: 'Isracard', billingDay: 2 },
};

export interface ImportSummary {
  workbook: string;
  worksheet: string;
  monthsParsed: number;
  startDate: string;
  startBalance: number;
  cardsCreated: number;
  recurringCreated: number;
  ledgerCreated: number;
  warnings: string[];
  skippedRows: { label: string; reason: string }[];
  orphanedLedger: number;
  orphanedRecurring: number;
  legacyLedgerRemoved: number;
  legacyRecurringRemoved: number;
}

const skipLabels = new Set(['карта потрачено']);
const pad = (n: number): string => (n < 10 ? `0${n}` : String(n));
const daysInMonth = (year: number, month: number): number =>
  new Date(year, month, 0).getDate();
const clampedDate = (monthKey: string, day: number): string => {
  const [yStr, mStr] = monthKey.split('-');
  const year = Number(yStr);
  const month = Number(mStr);
  const clamped = Math.min(day, daysInMonth(year, month));
  return `${yStr}-${mStr}-${pad(clamped)}`;
};
const describe = (row: ExpenseRow): string =>
  row.source ? `[${row.source}] ${row.labelTrimmed}` : row.labelTrimmed;
const sanitizeId = (s: string): string =>
  s
    .normalize('NFKD')
    .replace(/[^a-zA-Z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .toLowerCase()
    .slice(0, 32) || 'row';
const EXCEL_PREFIX = 'excel:';
const sourceKey = (s: string): string => (s.trim() || '_').toLowerCase();
const excelRecurringId = (row: ExpenseRow): string =>
  `${EXCEL_PREFIX}r:${sourceKey(row.source)}:${sanitizeId(row.labelTrimmed)}:${row.day ?? 'x'}`;
const excelLedgerId = (row: ExpenseRow, monthKey: string): string =>
  `${EXCEL_PREFIX}l:${sourceKey(row.source)}:${sanitizeId(row.labelTrimmed)}:${monthKey.slice(0, 7)}`;
const excelCardBillId = (cardId: string, monthKey: string): string =>
  `${EXCEL_PREFIX}l:cardbill:${cardId}:${monthKey.slice(0, 7)}`;

/**
 * A row qualifies as a recurring template when it shows the same value
 * across N consecutive workbook months (N >= 2 covers the legacy
 * full-span case; N >= 3 covers mid-span bounded schedules). The window
 * must have no internal gaps — gappy rows fall through to variable
 * (per-month) ledger entries.
 *
 * Returned `firstMonthIdx` / `lastMonthIdx` index into `monthKeys` and
 * carry the inferred startDate / endDate window. `amount` is read from
 * the first occurrence (not `firstMonth.key` — relevant when the row
 * does not cover the entire workbook span).
 */
type RecurringCandidate = {
  row: ExpenseRow;
  firstMonthIdx: number;
  lastMonthIdx: number;
  amount: number;
};

const partitionRows = (
  rows: ExpenseRow[],
  monthKeys: string[],
): {
  recurringRows: RecurringCandidate[];
  variableRows: ExpenseRow[];
  skipped: { label: string; reason: string }[];
} => {
  const recurringRows: RecurringCandidate[] = [];
  const variableRows: ExpenseRow[] = [];
  const skipped: { label: string; reason: string }[] = [];
  for (const row of rows) {
    if (row.kind === 'derived' && row.labelTrimmed !== 'карта остаток') {
      skipped.push({ label: row.labelTrimmed, reason: 'derived row' });
      continue;
    }
    if (skipLabels.has(row.labelTrimmed)) {
      skipped.push({ label: row.labelTrimmed, reason: 'workbook book-keeping row' });
      continue;
    }
    const nonNullValues: number[] = [];
    const nonNullIndices: number[] = [];
    for (let i = 0; i < monthKeys.length; i++) {
      const v = row.amounts[monthKeys[i]!]?.value;
      if (typeof v === 'number') {
        nonNullValues.push(v);
        nonNullIndices.push(i);
      }
    }
    if (nonNullValues.length === 0) {
      skipped.push({ label: row.labelTrimmed, reason: 'no values in any month' });
      continue;
    }
    if (nonNullValues.every((v) => v === 0)) {
      skipped.push({ label: row.labelTrimmed, reason: 'all values zero' });
      continue;
    }
    const allEqual = nonNullValues.every((v) => v === nonNullValues[0]);
    const firstIdx = nonNullIndices[0]!;
    const lastIdx = nonNullIndices[nonNullIndices.length - 1]!;
    const noGaps = lastIdx - firstIdx + 1 === nonNullIndices.length;
    // Full-span runs may collapse to 2 occurrences; mid-span bounded
    // windows need stronger evidence (>=3) to avoid promoting unrelated
    // pairs (e.g. one-off + a coincidental repeat).
    const isFullSpan = firstIdx === 0 && lastIdx === monthKeys.length - 1;
    const enough = isFullSpan ? nonNullValues.length >= 2 : nonNullValues.length >= 3;
    if (row.day != null && allEqual && noGaps && enough) {
      recurringRows.push({
        row,
        firstMonthIdx: firstIdx,
        lastMonthIdx: lastIdx,
        amount: nonNullValues[0]!,
      });
    } else {
      variableRows.push(row);
    }
  }
  return { recurringRows, variableRows, skipped };
};

export interface ImportOptions {
  /**
   * Preserve existing user-set Settings (threshold, timezone, workbookUrl).
   * When false, overwrites Settings with defaults. Default: true.
   */
  preserveSettings?: boolean;
}

export function importFromSnapshot(
  repo: StateRepo,
  snap: WorkbookSnapshot,
  opts: ImportOptions = {},
): ImportSummary {
  const preserveSettings = opts.preserveSettings ?? true;
  if (snap.months.length === 0) {
    throw new Error('Workbook has no months parsed.');
  }
  if (!snap.balanceRow) {
    throw new Error('Workbook has no balance row.');
  }
  const firstMonth = snap.months[0]!;
  const startBalance = snap.balanceRow.amounts[firstMonth.key]?.value;
  if (typeof startBalance !== 'number') {
    throw new Error(`Balance row has no number value at ${firstMonth.key}`);
  }

  const warnings: string[] = [...snap.warnings];

  // Legacy cleanup: old importer used l-/r- IDs without `excel:` prefix.
  let legacyLedgerRemoved = 0;
  let legacyRecurringRemoved = 0;
  for (const e of repo.listLedger()) {
    if (!e.id.startsWith(EXCEL_PREFIX) && /^l-/.test(e.id)) {
      repo.deleteLedger(e.id);
      legacyLedgerRemoved++;
    }
  }
  for (const t of repo.listRecurring()) {
    if (!t.id.startsWith(EXCEL_PREFIX) && /^r-/.test(t.id)) {
      repo.deleteRecurring(t.id);
      legacyRecurringRemoved++;
    }
  }
  if (legacyLedgerRemoved > 0)
    warnings.push(`Cleaned ${legacyLedgerRemoved} legacy ledger entries`);
  if (legacyRecurringRemoved > 0)
    warnings.push(`Cleaned ${legacyRecurringRemoved} legacy recurring templates`);

  const existingLedgerStatus = new Map<string, LedgerEntry['status']>();
  for (const e of repo.listLedger()) {
    if (e.id.startsWith(EXCEL_PREFIX)) existingLedgerStatus.set(e.id, e.status);
  }
  const existingRecurringIds = new Set(
    repo.listRecurring().map((r) => r.id).filter((id) => id.startsWith(EXCEL_PREFIX)),
  );
  const touchedLedgerIds = new Set<string>();
  const touchedRecurringIds = new Set<string>();

  // Wipe ONLY Excel-owned cards. User-created cards (POST /api/cards)
  // are preserved across re-imports — if any of their cc:<id> entries
  // would otherwise orphan when their referenced card is recreated.
  for (const c of repo.listCards()) {
    if (c.excelOwned) repo.deleteCard(c.id);
  }
  repo.upsertAccount({ bankBalance: startBalance, asOf: firstMonth.key });

  if (preserveSettings) {
    const existing = repo.getSettings();
    repo.upsertSettings({
      ...existing,
      horizonMonths: Math.max(existing.horizonMonths, snap.months.length),
    });
  } else {
    repo.upsertSettings({
      threshold: 2000,
      timezone: 'Asia/Jerusalem',
      horizonMonths: Math.max(1, snap.months.length),
      currency: 'ILS',
    });
  }

  const cardSourcesPresent = new Set(
    snap.rows.map((r) => r.source.toLowerCase()).filter((s) => s in CREDIT_CARD_SOURCES),
  );
  const cardSpentRows = snap.rows.filter((r) => r.labelTrimmed === 'карта потрачено');
  /**
   * Opening debit for a card.
   *
   * Excel's column delta is the SUM of every row in that column —
   * itemised cc rows AND a (manual) «карта потрачено» entry alike.
   * To make our forecast's bank effect for the first column match
   * Excel exactly, `currentDebit` must capture BOTH contributions:
   *
   *   currentDebit(card) = | «карта потрачено» first-month value |
   *                       + Σ | itemised cc-source rows in the first
   *                             column for this card (excluding the
   *                             «карта потрачено» row itself) |
   *
   * Those itemised rows are simultaneously SKIPPED from variable/
   * recurring imports (see below), so each charge is counted exactly
   * once — folded into `currentDebit` rather than duplicated as a
   * separate cc ledger entry. From the second column onwards the
   * forecast pipeline derives bills from itemised cc charges directly.
   */
  const debitForCard = (cardId: string): number => {
    let total = 0;
    const manual = cardSpentRows.find((r) => r.source.toLowerCase() === cardId);
    if (manual) {
      const v = manual.amounts[firstMonth.key]?.value;
      if (typeof v === 'number') total += Math.abs(v);
    }
    for (const r of snap.rows) {
      if (r.kind !== 'expense') continue;
      if (r.labelTrimmed === 'карта потрачено') continue;
      if (r.source.toLowerCase() !== cardId) continue;
      const v = r.amounts[firstMonth.key]?.value;
      if (typeof v !== 'number') continue;
      total += Math.abs(v);
    }
    return total;
  };

  let cardsCreated = 0;
  for (const cardId of cardSourcesPresent) {
    const def = CREDIT_CARD_SOURCES[cardId]!;
    const card: CreditCard = {
      id: cardId,
      name: def.name,
      currentDebit: debitForCard(cardId),
      asOf: firstMonth.key,
      billingDayOfMonth: def.billingDay,
      excelOwned: true,
    };
    repo.upsertCard(card);
    cardsCreated++;
  }

  const anchorDay = 10;
  const scheduleDateForColumn = (monthKey: string, day: number | null): string => {
    const d = day ?? anchorDay;
    const [yStr, mStr] = monthKey.split('-');
    let year = Number(yStr);
    let month = Number(mStr);
    if (d <= anchorDay) {
      month += 1;
      if (month > 12) {
        month -= 12;
        year += 1;
      }
    }
    const clamped = Math.min(d, daysInMonth(year, month));
    return `${year}-${pad(month)}-${pad(clamped)}`;
  };

  // Channel routing: rows whose `source` is a recognised credit card
  // (cal/isra) are routed to that card's cc channel so the forecast
  // pipeline rolls them up into the next billing day. All other rows
  // hit the bank directly.
  //
  // Period semantics — crucial for parity with Excel:
  //   • The first column's «карта потрачено» seeds `card.currentDebit`.
  //     That value is the SUM of all itemised first-column cal/isra
  //     rows. To avoid double-counting, we therefore SKIP first-month
  //     cc rows entirely (variable AND the first recurring occurrence)
  //     and let `currentDebit` represent that entire period.
  //   • For non-first columns, each column's cal/isra charges should
  //     bill on the cycle that closes that column. We date variable cc
  //     entries on `clampedDate(columnMonth, day)` (no anchor shift),
  //     so they bill on the next billing day after the column month.
  //   • For bank rows we keep the legacy `scheduleDateForColumn`
  //     anchor-shift, which threads charges into the [anchor, anchor]
  //     window the column represents.
  const channelForRow = (row: ExpenseRow): Channel => {
    const src = row.source.toLowerCase();
    if (src in CREDIT_CARD_SOURCES) return `cc:${src}` as Channel;
    return 'bank';
  };
  const isCcRow = (row: ExpenseRow): boolean =>
    row.source.toLowerCase() in CREDIT_CARD_SOURCES;

  const firstMonthKey = firstMonth.key;

  const { recurringRows, variableRows, skipped } = partitionRows(
    snap.rows,
    snap.months.map((m) => m.key),
  );

  let recurringCreated = 0;
  let ledgerCreated = 0;
  const upsertImportedLedger = (id: string, entry: Omit<LedgerEntry, 'id' | 'status'>): string => {
    let finalId = id;
    let n = 2;
    while (touchedLedgerIds.has(finalId)) finalId = `${id}:${n++}`;
    const status = existingLedgerStatus.get(finalId) ?? 'pending';
    repo.upsertLedger({ ...entry, id: finalId, status });
    touchedLedgerIds.add(finalId);
    ledgerCreated++;
    return finalId;
  };
  const upsertImportedRecurring = (id: string, tpl: Omit<RecurringTemplate, 'id'>): string => {
    let finalId = id;
    let n = 2;
    while (touchedRecurringIds.has(finalId)) finalId = `${id}:${n++}`;
    repo.upsertRecurring({ ...tpl, id: finalId });
    touchedRecurringIds.add(finalId);
    recurringCreated++;
    return finalId;
  };

  // NOTE: we intentionally do NOT generate per-period «карта потрачено»
  // bank-channel ledger entries here anymore. Card bills are now derived
  // by the forecast pipeline from cc-channel outstanding (rolled up from
  // individual cal/isra rows). Any legacy `excel:l:cardbill:*` entries
  // from earlier imports will be GC'd by the orphan sweep below.

  for (const c of recurringRows) {
    const { row, firstMonthIdx, lastMonthIdx, amount } = c;
    if (row.day == null) continue;
    const monthKeys = snap.months.map((m) => m.key);
    const startMonthKey = monthKeys[firstMonthIdx]!;
    const endMonthKey = monthKeys[lastMonthIdx]!;
    const isOpenEnded = lastMonthIdx === monthKeys.length - 1;
    const startDate = clampedDate(startMonthKey, row.day);
    const endDate = isOpenEnded ? undefined : clampedDate(endMonthKey, row.day);
    // Bounded windows include the window start in the ID so two
    // distinct fixed-term schedules with the same source/label/day
    // get stable, non-colliding IDs across re-imports.
    const baseId = excelRecurringId(row);
    const tplId = isOpenEnded ? baseId : `${baseId}:${startMonthKey}`;
    const tpl: Omit<RecurringTemplate, 'id'> = {
      description: describe(row),
      amount,
      channel: channelForRow(row),
      cadence: { kind: 'monthly', day: row.day, monthEndPolicy: 'clamp' },
      startDate,
    };
    if (endDate) tpl.endDate = endDate;
    const finalTplId = upsertImportedRecurring(tplId, tpl);

    // Preserve user-cleared state across the migration. If any of the
    // old per-month ledger rows that this template now subsumes was
    // marked cleared, materialise an override ledger entry so the new
    // template's occurrence appears cleared in the timeline.
    for (let i = firstMonthIdx; i <= lastMonthIdx; i++) {
      const mKey = monthKeys[i]!;
      const oldLedgerId = excelLedgerId(row, mKey);
      if (existingLedgerStatus.get(oldLedgerId) !== 'cleared') continue;
      const date = clampedDate(mKey, row.day);
      const overrideId = `${EXCEL_PREFIX}l:override:${finalTplId}:${date}`;
      const overrideEntry: LedgerEntry = {
        id: overrideId,
        description: describe(row),
        amount,
        channel: channelForRow(row),
        date,
        status: 'cleared',
        recurringId: finalTplId,
        occurrenceKey: `${finalTplId}@${date}`,
      };
      repo.upsertLedger(overrideEntry);
      touchedLedgerIds.add(overrideId);
      // Track so the orphan GC doesn't remove it next run.
      existingLedgerStatus.set(overrideId, 'cleared');
      ledgerCreated++;
    }
  }

  for (const row of variableRows) {
    const cc = isCcRow(row);
    for (const m of snap.months) {
      const v = row.amounts[m.key]?.value;
      if (typeof v !== 'number' || v === 0) continue;
      // Skip first-month cc variable rows — already in currentDebit.
      if (cc && m.key === firstMonthKey) continue;
      const date = cc
        ? clampedDate(m.key, row.day ?? anchorDay)
        : scheduleDateForColumn(m.key, row.day);
      upsertImportedLedger(excelLedgerId(row, m.key), {
        description: describe(row),
        amount: v,
        channel: channelForRow(row),
        date,
      });
    }
  }

  let orphanedLedger = 0;
  let orphanedRecurring = 0;
  for (const id of existingLedgerStatus.keys()) {
    if (!touchedLedgerIds.has(id)) {
      repo.deleteLedger(id);
      orphanedLedger++;
    }
  }
  for (const id of existingRecurringIds) {
    if (!touchedRecurringIds.has(id)) {
      repo.deleteRecurring(id);
      orphanedRecurring++;
    }
  }
  if (orphanedLedger > 0)
    warnings.push(`Removed ${orphanedLedger} stale Excel ledger entries`);
  if (orphanedRecurring > 0)
    warnings.push(`Removed ${orphanedRecurring} stale Excel recurring templates`);

  return {
    workbook: snap.workbook.name,
    worksheet: snap.workbook.worksheet,
    monthsParsed: snap.months.length,
    startDate: firstMonth.key,
    startBalance,
    cardsCreated,
    recurringCreated,
    ledgerCreated,
    warnings,
    skippedRows: skipped,
    orphanedLedger,
    orphanedRecurring,
    legacyLedgerRemoved,
    legacyRecurringRemoved,
  };
}
