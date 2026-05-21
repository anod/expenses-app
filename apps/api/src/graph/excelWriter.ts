import type { Logger } from 'pino';
import type {
  Account,
  CreditCard,
  LedgerEntry,
  RecurringTemplate,
  Settings,
} from '@expenses/shared';
import { parseDescription } from '@expenses/shared';
import { GraphClient, GraphError } from './graphClient.js';
import { WorkbookResolver, type DriveItemRef } from './workbookResolver.js';
import { encodeWorksheetName } from './graphReader.js';

export { parseDescription };

export type CellValue = string | number | null;
export type SheetGrid = CellValue[][];

export type SyncMode = 'overwrite' | 'new';

export interface SyncState {
  account: Account;
  cards: CreditCard[];
  recurring: RecurringTemplate[];
  ledger: LedgerEntry[];
  settings: Settings;
}

export interface SyncOptions {
  /** Target sheet for the anchor-period layout. Default: "Snapshot". */
  targetSheet?: string;
  /** When 'new', the target sheet must not exist (or is auto-renamed). */
  mode?: SyncMode;
  /** Sheet name for the flat StateRaw tables. Default: "StateRaw". */
  rawSheetName?: string;
}

export interface SyncResult {
  workbook: string;
  targetSheet: string;
  rawSheet: string;
  mode: SyncMode;
  anchorRows: number;
  anchorCols: number;
  rawRows: number;
  syncedAt: string;
}

const COLUMN_LETTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';

/** Convert a 0-based column index to an Excel letter (A, B, ..., Z, AA, ...). */
export const colLetter = (i: number): string => {
  let n = i;
  let out = '';
  while (true) {
    out = COLUMN_LETTERS[n % 26] + out;
    n = Math.floor(n / 26) - 1;
    if (n < 0) break;
  }
  return out;
};

/** Compute the A1 address for a grid filled top-left at A1. */
export const rangeA1 = (rows: number, cols: number): string =>
  `A1:${colLetter(cols - 1)}${rows}`;

const MONTH_SHORT = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** Format YYYY-MM-DD into "DD-Mon-YY" (matches existing Sheet1 header style). */
export const formatAnchorHeader = (iso: string): string => {
  const [y, m, d] = iso.split('-').map((v) => Number(v));
  return `${String(d).padStart(2, '0')}-${MONTH_SHORT[(m as number) - 1]}-${String(y as number).slice(-2)}`;
};

/** Add `months` calendar months to the YYYY-MM-DD `iso`, clamping the day. */
export const addMonthsIso = (iso: string, months: number): string => {
  const [y, m, d] = iso.split('-').map((v) => Number(v)) as [number, number, number];
  let year = y;
  let month = m + months;
  while (month > 12) {
    month -= 12;
    year++;
  }
  while (month < 1) {
    month += 12;
    year--;
  }
  const daysInTarget = new Date(year, month, 0).getDate();
  const day = Math.min(d, daysInTarget);
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
};

/** Inclusive lexicographic comparison: a > b ? */
const gt = (a: string, b: string): boolean => a > b;
/** a > b && a <= c */
const inPeriod = (date: string, prevAnchor: string, anchor: string): boolean =>
  gt(date, prevAnchor) && date <= anchor;

// ---------- Anchor sheet renderer -------------------------------------------

interface AnchorRow {
  source: string;
  label: string;
  day: number | null;
  /** Value per anchor column (length = anchors.length). */
  values: (number | null)[];
}

export interface AnchorLayout {
  anchors: string[]; // ISO dates, ascending — first is the asOf snapshot
  rows: AnchorRow[];
  balances: number[]; // length === anchors.length
}

export const computeAnchors = (state: SyncState): string[] => {
  const anchors: string[] = [state.account.asOf];
  const horizon = Math.max(1, state.settings.horizonMonths);
  for (let i = 1; i <= horizon; i++) {
    anchors.push(addMonthsIso(state.account.asOf, i));
  }
  return anchors;
};

/** Build the anchor-column layout — Excel-style rows with per-period values. */
export const renderAnchorSheet = (state: SyncState): SheetGrid => {
  const anchors = computeAnchors(state);
  const rows: AnchorRow[] = [];

  // Group recurring + ledger by (source, label, day) into a single row.
  const rowKey = (source: string, label: string, day: number | null): string =>
    `${source}|${label}|${day ?? ''}`;
  const rowMap = new Map<string, AnchorRow>();

  const ensureRow = (source: string, label: string, day: number | null): AnchorRow => {
    const k = rowKey(source, label, day);
    let r = rowMap.get(k);
    if (!r) {
      r = { source, label, day, values: anchors.map(() => null) };
      rowMap.set(k, r);
      rows.push(r);
    }
    return r;
  };

  const addValue = (r: AnchorRow, colIdx: number, v: number): void => {
    r.values[colIdx] = (r.values[colIdx] ?? 0) + v;
  };

  // Recurring → emit per-anchor-period value (apply once per period the cadence
  // day falls into). Day is the row's day.
  for (const t of state.recurring) {
    // Only exact monthly day-of-month templates are round-trippable in the
    // current anchor sheet schema. Skip weekly and monthly-prediction rows
    // here — live forecast totals remain correct even though they don't
    // appear in this snapshot export.
    if (t.cadence.kind !== 'monthly') continue;
    const { source, label } = parseDescription(t.description);
    const row = ensureRow(source, label, t.cadence.day);
    for (let i = 0; i < anchors.length - 1; i++) {
      const periodEnd = anchors[i + 1]!;
      const periodStart = anchors[i]!;
      // Place value in column whose period (periodStart, periodEnd] would
      // contain a day-of-month occurrence of t.day.
      // Apply once per period unless template start/end excludes it.
      if (t.startDate && periodEnd < t.startDate) continue;
      if (t.endDate && periodStart >= t.endDate) continue;
      addValue(row, i, t.amount);
    }
  }

  // Ledger entries → place in the period (prev-anchor, anchor] their date falls into.
  const cardBillRe = /^excel:l:cardbill:([^:]+):/;
  for (const e of state.ledger) {
    if (e.status === 'cleared') continue;
    let source: string;
    let label: string;
    let day: number | null = Number(e.date.slice(-2));
    if (Number.isNaN(day)) day = null;
    const billMatch = cardBillRe.exec(e.id);
    if (billMatch) {
      // Card-bill entries map back to the «карта потрачено» row for the card.
      source = billMatch[1]!;
      label = 'карта потрачено';
      day = null;
    } else {
      const parsed = parseDescription(e.description);
      source = parsed.source;
      label = parsed.label;
    }
    const row = ensureRow(source, label, day);
    for (let i = 0; i < anchors.length - 1; i++) {
      if (inPeriod(e.date, anchors[i]!, anchors[i + 1]!)) {
        addValue(row, i, e.amount);
        break;
      }
    }
  }

  // Account balance row: column i shows the projected balance AT anchor[i].
  // We can derive each anchor balance as: prior balance + sum of values in
  // prior column (Excel's =SUM(prev_col) formula).
  const balances: number[] = [];
  balances.push(state.account.bankBalance); // at asOf
  for (let i = 1; i < anchors.length; i++) {
    let delta = 0;
    for (const r of rows) delta += r.values[i - 1] ?? 0;
    balances.push(balances[i - 1]! + delta);
  }

  // Add «карта остаток» rows derived from credit cards — informational mirror
  // of where the user's card debt sits at each anchor. Without forecast cycle
  // data here we leave it blank; it's reconstructable from the cards table.
  for (const c of state.cards) {
    ensureRow(c.id, 'карта остаток', null);
  }

  // ------ Assemble grid ----------------------------------------------------
  const header: CellValue[] = ['source', 'day', 'description', ...anchors.map(formatAnchorHeader)];
  const balanceRow: CellValue[] = ['', '', 'счет', ...balances.map((b) => Number(b.toFixed(2)))];

  // Sort rows: cardbill rows first (per card), then recurring/ledger by source then label.
  rows.sort((a, b) => {
    const aBook = a.label === 'карта потрачено' || a.label === 'карта остаток' ? 0 : 1;
    const bBook = b.label === 'карта потрачено' || b.label === 'карта остаток' ? 0 : 1;
    if (aBook !== bBook) return aBook - bBook;
    if (a.source !== b.source) return a.source.localeCompare(b.source);
    return a.label.localeCompare(b.label);
  });

  const dataRows: CellValue[][] = rows.map((r) => [
    r.source,
    r.day ?? '',
    r.label,
    ...r.values.map((v) => (v == null ? '' : Number(v.toFixed(2)))),
  ]);

  return [header, balanceRow, ...dataRows];
};

// ---------- StateRaw sheet renderer -----------------------------------------

/** Build a flat-tables sheet with all four domain tables, sections separated by blank rows. */
export const renderStateRawSheet = (state: SyncState): SheetGrid => {
  const out: CellValue[][] = [];
  const pad = (row: CellValue[], width: number): CellValue[] =>
    row.length >= width ? row : [...row, ...new Array(width - row.length).fill('')];

  // Determine max width across all sections so the range PATCH stays rectangular.
  const widths = [
    2, // account
    5, // card
    8, // recurring
    8, // ledger
    4, // settings
  ];
  const maxW = Math.max(...widths);

  out.push(pad(['# account'], maxW));
  out.push(pad(['bankBalance', 'asOf'], maxW));
  out.push(pad([state.account.bankBalance, state.account.asOf], maxW));
  out.push(pad([], maxW));

  out.push(pad(['# cards'], maxW));
  out.push(pad(['id', 'name', 'currentDebit', 'asOf', 'billingDayOfMonth'], maxW));
  for (const c of state.cards) {
    out.push(pad([c.id, c.name, c.currentDebit, c.asOf, c.billingDayOfMonth], maxW));
  }
  out.push(pad([], maxW));

  out.push(pad(['# recurring'], maxW));
  out.push(pad(['id', 'description', 'amount', 'channel', 'day', 'monthEndPolicy', 'startDate', 'endDate'], maxW));
  let nonMonthlySkipped = 0;
  for (const t of state.recurring) {
    if (t.cadence.kind !== 'monthly') {
      nonMonthlySkipped++;
      continue;
    }
    out.push(pad([
      t.id,
      t.description,
      t.amount,
      t.channel,
      t.cadence.day,
      t.cadence.monthEndPolicy,
      t.startDate ?? '',
      t.endDate ?? '',
    ], maxW));
  }
  if (nonMonthlySkipped > 0) {
    out.push(pad([`# warning: ${nonMonthlySkipped} non-monthly templates excluded — not round-trippable in current Excel format`], maxW));
  }
  out.push(pad([], maxW));

  out.push(pad(['# ledger'], maxW));
  out.push(pad(['id', 'date', 'description', 'amount', 'channel', 'status', 'recurringId', 'occurrenceKey'], maxW));
  for (const e of state.ledger) {
    out.push(pad([
      e.id,
      e.date,
      e.description,
      e.amount,
      e.channel,
      e.status,
      e.recurringId ?? '',
      e.occurrenceKey ?? '',
    ], maxW));
  }
  out.push(pad([], maxW));

  out.push(pad(['# settings'], maxW));
  out.push(pad(['threshold', 'horizonMonths', 'currency', 'timezone'], maxW));
  out.push(pad([state.settings.threshold, state.settings.horizonMonths, state.settings.currency, state.settings.timezone], maxW));

  return out;
};

// ---------- Writer service --------------------------------------------------

export interface ExcelWriterOptions {
  client: GraphClient;
  resolver: WorkbookResolver;
  log: Logger;
}

interface WorksheetSummary {
  id: string;
  name: string;
}

export class ExcelWriter {
  constructor(private readonly opts: ExcelWriterOptions) {}

  async sync(state: SyncState, accessToken: string, options: SyncOptions = {}): Promise<SyncResult> {
    const targetSheet = options.targetSheet?.trim() || 'Snapshot';
    const rawSheet = options.rawSheetName?.trim() || 'StateRaw';
    const mode: SyncMode = options.mode ?? 'overwrite';

    const ref = await this.opts.resolver.resolve(accessToken);
    const sheets = await this.listSheets(ref, accessToken);
    const sheetNames = new Set(sheets.map((s) => s.name));

    const finalTargetName =
      mode === 'new' && sheetNames.has(targetSheet) ? this.uniqueName(targetSheet, sheetNames) : targetSheet;

    if (!sheetNames.has(finalTargetName)) {
      await this.addSheet(ref, accessToken, finalTargetName);
      sheetNames.add(finalTargetName);
    } else {
      await this.clearSheet(ref, accessToken, finalTargetName);
    }
    if (!sheetNames.has(rawSheet)) {
      await this.addSheet(ref, accessToken, rawSheet);
      sheetNames.add(rawSheet);
    } else {
      await this.clearSheet(ref, accessToken, rawSheet);
    }

    const anchorGrid = renderAnchorSheet(state);
    const rawGrid = renderStateRawSheet(state);

    await this.writeGrid(ref, accessToken, finalTargetName, anchorGrid);
    await this.writeGrid(ref, accessToken, rawSheet, rawGrid);

    return {
      workbook: ref.name,
      targetSheet: finalTargetName,
      rawSheet,
      mode,
      anchorRows: anchorGrid.length,
      anchorCols: anchorGrid[0]?.length ?? 0,
      rawRows: rawGrid.length,
      syncedAt: new Date().toISOString(),
    };
  }

  private uniqueName(base: string, taken: Set<string>): string {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    let name = `${base}-${stamp}`;
    let n = 2;
    while (taken.has(name)) name = `${base}-${stamp}-${n++}`;
    return name;
  }

  private async listSheets(ref: DriveItemRef, accessToken: string): Promise<WorksheetSummary[]> {
    const res = await this.opts.client.request<{ value: WorksheetSummary[] }>({
      path: `/drives/${ref.driveId}/items/${ref.itemId}/workbook/worksheets?$select=id,name`,
      accessToken,
    });
    return res.value ?? [];
  }

  private async addSheet(ref: DriveItemRef, accessToken: string, name: string): Promise<void> {
    await this.opts.client.request({
      method: 'POST',
      path: `/drives/${ref.driveId}/items/${ref.itemId}/workbook/worksheets/add`,
      accessToken,
      body: { name },
    });
  }

  private async clearSheet(ref: DriveItemRef, accessToken: string, name: string): Promise<void> {
    const ws = encodeWorksheetName(name);
    try {
      await this.opts.client.request({
        method: 'POST',
        path: `/drives/${ref.driveId}/items/${ref.itemId}/workbook/worksheets('${ws}')/usedRange/clear`,
        accessToken,
        body: { applyTo: 'all' },
      });
    } catch (err) {
      // If the sheet is empty there's no usedRange — Graph returns 400. Ignore.
      if (err instanceof GraphError && (err.status === 400 || err.status === 404)) return;
      throw err;
    }
  }

  private async writeGrid(
    ref: DriveItemRef,
    accessToken: string,
    name: string,
    grid: SheetGrid,
  ): Promise<void> {
    if (grid.length === 0) return;
    const cols = grid[0]!.length;
    const address = rangeA1(grid.length, cols);
    const ws = encodeWorksheetName(name);
    await this.opts.client.request({
      method: 'PATCH',
      path: `/drives/${ref.driveId}/items/${ref.itemId}/workbook/worksheets('${ws}')/range(address='${address}')`,
      accessToken,
      body: { values: grid },
    });
  }
}
