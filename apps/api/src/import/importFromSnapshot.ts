/**
 * Excel → SQLite importer (reusable from CLI and API).
 *
 * Accepts a parsed `WorkbookSnapshot` and a `StateRepo`, applies the
 * idempotent import described in `apps/api/src/scripts/import-excel.ts`,
 * and returns a summary. See that file's header comment for semantics.
 */
import { createHash } from 'node:crypto';
import {
  monthlyPredictionDate,
  scheduleDateForAnchorColumn,
  type Channel,
  type ExpenseRow,
  type LedgerEntry,
  type RecurringTemplate,
  type CreditCard,
  type WorkbookSnapshot,
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

type CadenceKind = RecurringTemplate['cadence']['kind'];
type RowMonthValue = { monthIdx: number; monthKey: string; amount: number };
type RecurringCandidate = {
  row: ExpenseRow;
  firstMonthIdx: number;
  lastMonthIdx: number;
  includedMonthIndices: number[];
  amount: number;
  cadenceKind: CadenceKind;
  wholeRow: boolean;
  noGaps: boolean;
};

const collectRowMonthValues = (row: ExpenseRow, monthKeys: string[]): RowMonthValue[] => {
  const out: RowMonthValue[] = [];
  for (let i = 0; i < monthKeys.length; i++) {
    const monthKey = monthKeys[i]!;
    const v = row.amounts[monthKey]?.value;
    if (typeof v === 'number' && v !== 0) out.push({ monthIdx: i, monthKey, amount: v });
  }
  return out;
};

const enoughRecurringEvidence = (opts: {
  count: number;
  isFullSpan: boolean;
  noGaps: boolean;
  wholeRow: boolean;
  daySpecified: boolean;
}): boolean => {
  if (!opts.wholeRow || !opts.noGaps || !opts.daySpecified) return opts.count >= 3;
  return opts.isFullSpan ? opts.count >= 2 : opts.count >= 3;
};

const recurrenceIdForCandidate = (
  row: ExpenseRow,
  monthKeys: string[],
  candidate: RecurringCandidate,
): string => {
  const baseId = excelRecurringId(row);
  const isOpenEnded = candidate.lastMonthIdx === monthKeys.length - 1;
  if (row.day != null && candidate.wholeRow && candidate.noGaps) {
    const startMonthKey = monthKeys[candidate.firstMonthIdx]!;
    return isOpenEnded ? baseId : `${baseId}:${startMonthKey}`;
  }
  const pattern = candidate.includedMonthIndices.map((idx) => monthKeys[idx]!.slice(0, 7)).join(',');
  const hash = createHash('sha1').update(pattern).digest('hex').slice(0, 10);
  return `${baseId}:${monthKeys[candidate.firstMonthIdx]!.slice(0, 7)}:${hash}`;
};

const inferRecurringCandidates = (
  row: ExpenseRow,
  monthKeys: string[],
): {
  recurringRows: RecurringCandidate[];
  ledgerMonthIndices: number[];
  skipped?: { label: string; reason: string };
} => {
  if (row.kind === 'derived' && row.labelTrimmed !== 'карта остаток') {
    return {
      recurringRows: [],
      ledgerMonthIndices: [],
      skipped: { label: row.labelTrimmed, reason: 'derived row' },
    };
  }
  if (skipLabels.has(row.labelTrimmed)) {
    return {
      recurringRows: [],
      ledgerMonthIndices: [],
      skipped: { label: row.labelTrimmed, reason: 'workbook book-keeping row' },
    };
  }

  const values = collectRowMonthValues(row, monthKeys);
  if (values.length === 0) {
    const sawNumber = monthKeys.some((monthKey) => typeof row.amounts[monthKey]?.value === 'number');
    return {
      recurringRows: [],
      ledgerMonthIndices: [],
      skipped: { label: row.labelTrimmed, reason: sawNumber ? 'all values zero' : 'no values in any month' },
    };
  }

  const cadenceKind: CadenceKind = row.day == null ? 'monthly_prediction' : 'monthly';
  const firstMonthIdx = values[0]!.monthIdx;
  const lastMonthIdx = values[values.length - 1]!.monthIdx;
  const isFullSpan = firstMonthIdx === 0 && lastMonthIdx === monthKeys.length - 1;
  const noGaps = lastMonthIdx - firstMonthIdx + 1 === values.length;
  const allEqual = values.every((v) => v.amount === values[0]!.amount);

  if (
    allEqual &&
    enoughRecurringEvidence({
      count: values.length,
      isFullSpan,
      noGaps,
      wholeRow: true,
      daySpecified: row.day != null,
    })
  ) {
    return {
      recurringRows: [{
        row,
        firstMonthIdx,
        lastMonthIdx,
        includedMonthIndices: values.map((v) => v.monthIdx),
        amount: values[0]!.amount,
        cadenceKind,
        wholeRow: true,
        noGaps,
      }],
      ledgerMonthIndices: [],
    };
  }

  const recurringRows: RecurringCandidate[] = [];
  const coveredIndices = new Set<number>();
  let run: RowMonthValue[] = [];
  const flushRun = (): void => {
    if (run.length === 0) return;
    const runFirst = run[0]!.monthIdx;
    const runLast = run[run.length - 1]!.monthIdx;
    const runIsFullSpan = runFirst === 0 && runLast === monthKeys.length - 1;
    if (
      enoughRecurringEvidence({
        count: run.length,
        isFullSpan: runIsFullSpan,
        noGaps: true,
        wholeRow: false,
        daySpecified: row.day != null,
      })
    ) {
      recurringRows.push({
        row,
        firstMonthIdx: runFirst,
        lastMonthIdx: runLast,
        includedMonthIndices: run.map((v) => v.monthIdx),
        amount: run[0]!.amount,
        cadenceKind,
        wholeRow: false,
        noGaps: true,
      });
      for (const part of run) coveredIndices.add(part.monthIdx);
    }
    run = [];
  };

  for (const value of values) {
    const prev = run[run.length - 1];
    if (
      prev &&
      value.monthIdx === prev.monthIdx + 1 &&
      value.amount === prev.amount
    ) {
      run.push(value);
      continue;
    }
    flushRun();
    run = [value];
  }
  flushRun();

  return {
    recurringRows,
    ledgerMonthIndices: values.map((v) => v.monthIdx).filter((idx) => !coveredIndices.has(idx)),
  };
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
  const existingExcelCards = new Map(
    repo.listCards()
      .filter((c) => c.excelOwned)
      .map((c) => [c.id, c]),
  );

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
    const previous = existingExcelCards.get(cardId);
    const mode = previous?.mode ?? 'credit';
    const card: CreditCard = {
      id: cardId,
      name: def.name,
      currentDebit: mode === 'debit' ? 0 : debitForCard(cardId),
      asOf: firstMonth.key,
      billingDayOfMonth: def.billingDay,
      excelOwned: true,
      mode,
    };
    repo.upsertCard(card);
    cardsCreated++;
  }

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
  const monthKeys = snap.months.map((m) => m.key);
  const skipped: { label: string; reason: string }[] = [];
  const occurrenceDateForRowMonth = (row: ExpenseRow, monthKey: string): string => {
    if (row.day != null) return clampedDate(monthKey, row.day);
    return isCcRow(row) ? monthlyPredictionDate(monthKey) : scheduleDateForAnchorColumn(monthKey, null);
  };
  const plannedRows = snap.rows.map((row) => inferRecurringCandidates(row, monthKeys));
  for (const plan of plannedRows) {
    if (plan.skipped) skipped.push(plan.skipped);
  }

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

  for (let rowIdx = 0; rowIdx < snap.rows.length; rowIdx++) {
    const row = snap.rows[rowIdx]!;
    const plan = plannedRows[rowIdx]!;

    for (const candidate of plan.recurringRows) {
      const startMonthKey = monthKeys[candidate.firstMonthIdx]!;
      const endMonthKey = monthKeys[candidate.lastMonthIdx]!;
      const isOpenEnded = candidate.lastMonthIdx === monthKeys.length - 1;
      const includedKeys = new Set(candidate.includedMonthIndices.map((idx) => monthKeys[idx]!));
      const cadence: RecurringTemplate['cadence'] =
        candidate.cadenceKind === 'monthly_prediction'
          ? { kind: 'monthly_prediction' }
          : {
              kind: 'monthly',
              day: row.day as number,
              monthEndPolicy: 'clamp',
            };
      const tpl: Omit<RecurringTemplate, 'id'> = {
        description: describe(row),
        amount: candidate.amount,
        channel: channelForRow(row),
        cadence,
        startDate: occurrenceDateForRowMonth(row, startMonthKey),
      };
      if (!isOpenEnded) tpl.endDate = occurrenceDateForRowMonth(row, endMonthKey);
      const finalTplId = upsertImportedRecurring(
        recurrenceIdForCandidate(row, monthKeys, candidate),
        tpl,
      );

      for (let i = candidate.firstMonthIdx; i <= candidate.lastMonthIdx; i++) {
        const mKey = monthKeys[i]!;
        const date = occurrenceDateForRowMonth(row, mKey);
        if (!includedKeys.has(mKey)) {
          repo.addSkip(finalTplId, date);
          continue;
        }
        const oldLedgerId = excelLedgerId(row, mKey);
        if (existingLedgerStatus.get(oldLedgerId) !== 'cleared') continue;
        const overrideId = `${EXCEL_PREFIX}l:override:${finalTplId}:${date}`;
        const overrideEntry: LedgerEntry = {
          id: overrideId,
          description: describe(row),
          amount: candidate.amount,
          channel: channelForRow(row),
          date,
          status: 'cleared',
          recurringId: finalTplId,
          occurrenceKey: `${finalTplId}@${date}`,
        };
        repo.upsertLedger(overrideEntry);
        touchedLedgerIds.add(overrideId);
        existingLedgerStatus.set(overrideId, 'cleared');
        ledgerCreated++;
      }
    }

    const cc = isCcRow(row);
    for (const monthIdx of plan.ledgerMonthIndices) {
      const monthKey = monthKeys[monthIdx]!;
      const v = row.amounts[monthKey]?.value;
      if (typeof v !== 'number' || v === 0) continue;
      if (cc && monthKey === firstMonthKey) continue;
      const date = cc
        ? clampedDate(monthKey, row.day ?? 10)
        : scheduleDateForAnchorColumn(monthKey, row.day);
      upsertImportedLedger(excelLedgerId(row, monthKey), {
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
