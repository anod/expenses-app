export type RawCellValue = string | number | boolean | null;

export interface MonthColumn {
  /** ISO date for the 1st-of-month or workbook day; we use the workbook string verbatim and a normalized key. */
  key: string;             // e.g. "2026-05-10"
  label: string;           // e.g. "10-May-26" (verbatim from header)
  columnIndex: number;     // 0-based index in the used range
}

export interface CellRef {
  rowIndex: number;        // 0-based, relative to used range
  columnIndex: number;     // 0-based
}

export interface AmountCell extends CellRef {
  value: number | null;    // null for blanks, number for literal or formula result
  isFormula: boolean;
  formula: string | null;  // raw formula string ("=SUM(D2:D24)") or null
}

export type RowKind = 'balance' | 'expense' | 'derived';

export interface ExpenseRow {
  rowIndex: number;
  source: string;          // "" (cash), "cal", "onezero", "isra", ...
  day: number | null;      // 1..31, or null
  label: string;           // raw label, may have trailing whitespace
  labelTrimmed: string;
  kind: RowKind;
  /** Map keyed by MonthColumn.key for stable lookup. */
  amounts: Record<string, AmountCell>;
}

export interface WorkbookCurrency {
  /** ISO 4217 code, e.g. "ILS". null if undetectable. */
  code: string | null;
  /** Symbol extracted from numberFormat, e.g. "₪". null if undetectable. */
  symbol: string | null;
  /** BCP-47 locale extracted from numberFormat, e.g. "he-IL". null if undetectable. */
  locale: string | null;
  /** Raw numberFormat string we derived this from. */
  rawFormat: string | null;
}

export interface WorkbookMeta {
  name: string;
  worksheet: string;
  range: string;
  rowCount: number;
  columnCount: number;
  lastModifiedDateTime: string | null;
  fetchedAt: string;
  currency: WorkbookCurrency;
}

export interface WorkbookSnapshot {
  workbook: WorkbookMeta;
  months: MonthColumn[];
  balanceRow: ExpenseRow | null;
  rows: ExpenseRow[];        // expense + derived rows (balance excluded)
  warnings: string[];        // parser-level non-fatal issues
}
