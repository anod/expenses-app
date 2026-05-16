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

const partitionRows = (
  rows: ExpenseRow[],
  monthKeys: string[],
): {
  recurringRows: ExpenseRow[];
  variableRows: ExpenseRow[];
  skipped: { label: string; reason: string }[];
} => {
  const recurringRows: ExpenseRow[] = [];
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
    const nonNullValues = monthKeys
      .map((k) => row.amounts[k]?.value)
      .filter((v): v is number => typeof v === 'number');
    if (nonNullValues.length === 0) {
      skipped.push({ label: row.labelTrimmed, reason: 'no values in any month' });
      continue;
    }
    if (nonNullValues.every((v) => v === 0)) {
      skipped.push({ label: row.labelTrimmed, reason: 'all values zero' });
      continue;
    }
    const allEqual = nonNullValues.every((v) => v === nonNullValues[0]);
    const presentEveryMonth = monthKeys.every(
      (k) => typeof row.amounts[k]?.value === 'number',
    );
    if (row.day != null && allEqual && nonNullValues.length >= 2 && presentEveryMonth) {
      recurringRows.push(row);
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

  for (const c of repo.listCards()) repo.deleteCard(c.id);
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
  const debitForCard = (cardId: string): number => {
    const row = cardSpentRows.find((r) => r.source.toLowerCase() === cardId);
    if (!row) return 0;
    const v = row.amounts[firstMonth.key]?.value;
    return typeof v === 'number' ? Math.abs(v) : 0;
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
  // hit the bank directly. Pre-asOf card debt is carried via the
  // card's `currentDebit` (seeded above from first-month «карта потрачено»);
  // because cc entries are dated strictly AFTER asOf (see
  // scheduleDateForColumn), they never overlap with that carry-over.
  const channelForRow = (row: ExpenseRow): Channel => {
    const src = row.source.toLowerCase();
    if (src in CREDIT_CARD_SOURCES) return `cc:${src}` as Channel;
    return 'bank';
  };

  const { recurringRows, variableRows, skipped } = partitionRows(
    snap.rows,
    snap.months.map((m) => m.key),
  );

  let recurringCreated = 0;
  let ledgerCreated = 0;
  const upsertImportedLedger = (id: string, entry: Omit<LedgerEntry, 'id' | 'status'>): void => {
    let finalId = id;
    let n = 2;
    while (touchedLedgerIds.has(finalId)) finalId = `${id}:${n++}`;
    const status = existingLedgerStatus.get(finalId) ?? 'pending';
    repo.upsertLedger({ ...entry, id: finalId, status });
    touchedLedgerIds.add(finalId);
    ledgerCreated++;
  };
  const upsertImportedRecurring = (id: string, tpl: Omit<RecurringTemplate, 'id'>): void => {
    let finalId = id;
    let n = 2;
    while (touchedRecurringIds.has(finalId)) finalId = `${id}:${n++}`;
    repo.upsertRecurring({ ...tpl, id: finalId });
    touchedRecurringIds.add(finalId);
    recurringCreated++;
  };

  // NOTE: we intentionally do NOT generate per-period «карта потрачено»
  // bank-channel ledger entries here anymore. Card bills are now derived
  // by the forecast pipeline from cc-channel outstanding (rolled up from
  // individual cal/isra rows). Any legacy `excel:l:cardbill:*` entries
  // from earlier imports will be GC'd by the orphan sweep below.

  for (const row of recurringRows) {
    const amount = row.amounts[firstMonth.key]?.value;
    if (typeof amount !== 'number' || row.day == null) continue;
    upsertImportedRecurring(excelRecurringId(row), {
      description: describe(row),
      amount,
      channel: channelForRow(row),
      day: row.day,
      startDate: clampedDate(firstMonth.key, row.day),
      monthEndPolicy: 'clamp',
    });
  }

  for (const row of variableRows) {
    for (const m of snap.months) {
      const v = row.amounts[m.key]?.value;
      if (typeof v !== 'number' || v === 0) continue;
      const date = scheduleDateForColumn(m.key, row.day);
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
