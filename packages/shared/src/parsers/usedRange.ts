import type {
  AmountCell,
  ExpenseRow,
  MonthColumn,
  RawCellValue,
  WorkbookCurrency,
  WorkbookMeta,
  WorkbookSnapshot,
} from '../contracts/types.js';
import { parseCurrencyFormat } from './currency.js';

/** Raw shape returned by Microsoft Graph workbook usedRange endpoint. */
export interface RawUsedRange {
  address: string;
  rowCount: number;
  columnCount: number;
  values: RawCellValue[][];
  formulas?: (string | RawCellValue)[][];
  numberFormat?: string[][];
}

export interface RawWorkbookDump {
  workbook: {
    name: string;
    worksheet: string;
    lastModifiedDateTime?: string | null;
  };
  usedRange: RawUsedRange;
  dumpedAt?: string;
}

/** Number of fixed metadata columns at the start of each row: source, day, label. */
const META_COLS = 3;

/** Configurable label fallbacks for balance row detection. */
const BALANCE_LABELS = new Set(['счет', 'balance', 'итого', 'total']);

/** Derived-row label hints (manually-maintained running balances). */
const DERIVED_HINTS = ['остаток', 'remainder', 'balance left', 'остается'];

const MONTHS: Record<string, number> = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6,
  jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12,
};

/**
 * Convert "10-May-26" → "2026-05-10".
 * Falls back to the original string if it cannot be parsed.
 */
export function normalizeMonthLabel(label: string): string {
  const m = label.trim().match(/^(\d{1,2})[-\s]([A-Za-z]{3})[-\s](\d{2,4})$/);
  if (!m) return label;
  const day = Number(m[1]);
  const monthKey = (m[2] ?? '').toLowerCase();
  const month = MONTHS[monthKey];
  if (!month) return label;
  let year = Number(m[3]);
  if (year < 100) year += 2000;
  const mm = String(month).padStart(2, '0');
  const dd = String(day).padStart(2, '0');
  return `${year}-${mm}-${dd}`;
}

function coerceBlank(v: RawCellValue | undefined): RawCellValue | null {
  if (v === undefined || v === null) return null;
  if (typeof v === 'string' && v.trim() === '') return null;
  return v;
}

function asNumber(v: RawCellValue | null): number | null {
  if (v === null) return null;
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v === 'string') {
    const cleaned = v.replace(/[\s,₪$€£¥]/g, '').replace(/^\((.*)\)$/, '-$1');
    const n = Number(cleaned);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

function asString(v: RawCellValue | null): string {
  if (v === null) return '';
  return String(v);
}

function isFormula(f: unknown): f is string {
  return typeof f === 'string' && f.startsWith('=');
}

/** Extract month columns from the header row. */
function extractMonths(headers: RawCellValue[]): MonthColumn[] {
  const months: MonthColumn[] = [];
  for (let c = META_COLS; c < headers.length; c++) {
    const raw = headers[c];
    const label = raw === null || raw === undefined ? '' : String(raw).trim();
    if (!label) continue;
    months.push({
      key: normalizeMonthLabel(label),
      label,
      columnIndex: c,
    });
  }
  return months;
}

/**
 * Detect the balance row.
 * Strategy (first match wins):
 *   1. The row whose month cells are dominated by SUM(...) formulas.
 *   2. The row whose trimmed label matches a known balance label.
 */
function detectBalanceRowIndex(
  values: RawCellValue[][],
  formulas: (string | RawCellValue)[][] | undefined,
  months: MonthColumn[],
): number | null {
  if (formulas && months.length > 0) {
    for (let r = 1; r < formulas.length; r++) {
      const row = formulas[r];
      if (!row) continue;
      let sumCount = 0;
      for (const m of months) {
        const f = row[m.columnIndex];
        if (typeof f === 'string' && /^=SUM\s*\(/i.test(f)) sumCount++;
      }
      // require majority of month cells to be SUM formulas
      if (sumCount > 0 && sumCount >= Math.ceil(months.length / 2)) return r;
    }
  }
  for (let r = 1; r < values.length; r++) {
    const row = values[r];
    const label = (row?.[2] ?? '').toString().trim().toLowerCase();
    if (BALANCE_LABELS.has(label)) return r;
  }
  return null;
}

function classifyRowKind(label: string, isBalance: boolean): 'balance' | 'expense' | 'derived' {
  if (isBalance) return 'balance';
  const l = label.toLowerCase();
  if (DERIVED_HINTS.some((h) => l.includes(h))) return 'derived';
  return 'expense';
}

function buildRow(
  rowIndex: number,
  values: RawCellValue[],
  formulas: (string | RawCellValue)[] | undefined,
  months: MonthColumn[],
  isBalance: boolean,
): ExpenseRow {
  const source = asString(coerceBlank(values[0]));
  const dayRaw = coerceBlank(values[1]);
  const day = dayRaw === null ? null : asNumber(dayRaw);
  const labelRaw = asString(coerceBlank(values[2]));
  const labelTrimmed = labelRaw.trim();

  const amounts: Record<string, AmountCell> = {};
  for (const m of months) {
    const v = coerceBlank(values[m.columnIndex]);
    const f = formulas?.[m.columnIndex];
    const formulaStr = isFormula(f) ? f : null;
    amounts[m.key] = {
      rowIndex,
      columnIndex: m.columnIndex,
      value: asNumber(v),
      isFormula: formulaStr !== null,
      formula: formulaStr,
    };
  }

  return {
    rowIndex,
    source,
    day,
    label: labelRaw,
    labelTrimmed,
    kind: classifyRowKind(labelTrimmed, isBalance),
    amounts,
  };
}

/** Pick the currency from the balance row's number-format cells. */
function detectCurrency(
  numberFormat: string[][] | undefined,
  balanceRowIndex: number | null,
  months: MonthColumn[],
): WorkbookCurrency {
  if (!numberFormat || balanceRowIndex === null) {
    return { code: null, symbol: null, locale: null, rawFormat: null };
  }
  const row = numberFormat[balanceRowIndex];
  if (!row) return { code: null, symbol: null, locale: null, rawFormat: null };

  // Try each month cell until we find a parseable currency format.
  for (const m of months) {
    const fmt = row[m.columnIndex];
    if (!fmt) continue;
    const parsed = parseCurrencyFormat(fmt);
    if (parsed.code || parsed.symbol) return parsed;
  }
  return { code: null, symbol: null, locale: null, rawFormat: row[META_COLS] ?? null };
}

export interface ParseOptions {
  /** ISO timestamp to use as fetchedAt. Defaults to now. */
  fetchedAt?: string;
}

/**
 * Convert a raw Graph workbook dump into a normalized snapshot.
 * Pure function — no I/O.
 */
export function parseWorkbookDump(dump: RawWorkbookDump, opts: ParseOptions = {}): WorkbookSnapshot {
  const { workbook, usedRange } = dump;
  const warnings: string[] = [];

  if (!Array.isArray(usedRange.values) || usedRange.values.length === 0) {
    return {
      workbook: emptyMeta(workbook, usedRange, opts),
      months: [],
      balanceRow: null,
      rows: [],
      warnings: ['usedRange.values is empty'],
    };
  }

  const headerRow = usedRange.values[0] ?? [];
  const months = extractMonths(headerRow);
  if (months.length === 0) warnings.push('No month columns detected in header row');

  const balanceRowIndex = detectBalanceRowIndex(usedRange.values, usedRange.formulas, months);
  if (balanceRowIndex === null) warnings.push('Balance row could not be detected');

  const currency = detectCurrency(usedRange.numberFormat, balanceRowIndex, months);
  if (!currency.code && !currency.symbol) warnings.push('Currency could not be determined from numberFormat');

  let balanceRow: ExpenseRow | null = null;
  const rows: ExpenseRow[] = [];

  for (let r = 1; r < usedRange.values.length; r++) {
    const values = usedRange.values[r] ?? [];
    const formulas = usedRange.formulas?.[r];
    const isBalance = r === balanceRowIndex;
    const row = buildRow(r, values, formulas, months, isBalance);

    // Skip fully-empty rows (no label, no amounts).
    if (!row.labelTrimmed && Object.values(row.amounts).every((a) => a.value === null)) continue;

    if (isBalance) balanceRow = row;
    else rows.push(row);
  }

  return {
    workbook: {
      name: workbook.name,
      worksheet: workbook.worksheet,
      range: usedRange.address,
      rowCount: usedRange.rowCount,
      columnCount: usedRange.columnCount,
      lastModifiedDateTime: workbook.lastModifiedDateTime ?? null,
      fetchedAt: opts.fetchedAt ?? new Date().toISOString(),
      currency,
    },
    months,
    balanceRow,
    rows,
    warnings,
  };
}

function emptyMeta(
  workbook: RawWorkbookDump['workbook'],
  usedRange: RawUsedRange,
  opts: ParseOptions,
): WorkbookMeta {
  return {
    name: workbook.name,
    worksheet: workbook.worksheet,
    range: usedRange.address,
    rowCount: usedRange.rowCount,
    columnCount: usedRange.columnCount,
    lastModifiedDateTime: workbook.lastModifiedDateTime ?? null,
    fetchedAt: opts.fetchedAt ?? new Date().toISOString(),
    currency: { code: null, symbol: null, locale: null, rawFormat: null },
  };
}
