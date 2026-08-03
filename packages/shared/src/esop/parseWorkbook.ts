import type { RawCellValue } from '../contracts/types.js';
import type { RawUsedRange } from '../parsers/usedRange.js';
import type { EsopGrant, EsopUnlock, EsopWorkbookParseResult } from './types.js';

const REQUIRED_HEADERS = ['grant price', 'grant date', 'amount'];
const EXCEL_EPOCH_OFFSET = 25_569;
const MS_PER_DAY = 86_400_000;

interface HeaderMap {
  grantPrice: number;
  grantDate: number;
  amount: number;
  /** Every column whose header is a date serial/ISO date — one unlock tranche each. */
  unlocks: { index: number; date: string }[];
}

export function parseEsopUsedRange(usedRange: RawUsedRange): EsopWorkbookParseResult {
  const warnings: string[] = [];
  const values = usedRange.values;
  if (!Array.isArray(values) || values.length === 0) {
    return {
      assumptions: emptyAssumptions(),
      grants: [],
      warnings: ['ESOP usedRange.values is empty'],
    };
  }

  const text = usedRange.text as RawCellValue[][] | undefined;
  const header = findHeader(values, text);
  if (!header) {
    return {
      assumptions: emptyAssumptions(),
      grants: [],
      warnings: ['ESOP header row not found'],
    };
  }

  const grants = parseGrants(values, header.rowIndex, header.columns, warnings);
  const assumptions = parseAssumptions(values, warnings);
  return { assumptions, grants, warnings };
}

function findHeader(
  values: RawCellValue[][],
  text?: RawCellValue[][],
): { rowIndex: number; columns: HeaderMap } | null {
  for (let r = 0; r < values.length; r++) {
    const normalized = (text?.[r] ?? values[r])?.map((cell) => normalizeHeader(cell)) ?? [];
    const hasRequired = REQUIRED_HEADERS.every((h) => normalized.includes(h));
    if (!hasRequired) continue;
    const rawHeader = values[r] ?? [];
    const base = {
      grantPrice: normalized.indexOf('grant price'),
      grantDate: normalized.indexOf('grant date'),
      amount: normalized.indexOf('amount'),
    };
    const columns: HeaderMap = {
      ...base,
      unlocks: detectUnlockColumns(rawHeader, text?.[r], base),
    };
    return {
      rowIndex: r,
      columns,
    };
  }
  return null;
}

function parseGrants(
  values: RawCellValue[][],
  headerRow: number,
  columns: HeaderMap,
  warnings: string[],
): EsopGrant[] {
  const grants: EsopGrant[] = [];
  for (let r = headerRow + 1; r < values.length; r++) {
    const row = values[r] ?? [];
    const grantPrice = asNumber(row[columns.grantPrice]);
    const grantDateSerial = asNumber(row[columns.grantDate]);
    const amount = asNumber(row[columns.amount]);
    const unlocks = readGrantUnlocks(row, columns.unlocks);
    const hasAnyGrantCell = [row[columns.grantPrice], row[columns.grantDate], row[columns.amount]]
      .some((cell) => cell !== null && cell !== undefined && String(cell).trim() !== '');

    if (!hasAnyGrantCell) {
      if (grants.length > 0) break;
      continue;
    }
    if (grantPrice === null || grantDateSerial === null || amount === null) {
      if (grants.length > 0) break;
      warnings.push(`Skipped ESOP row ${r + 1}: grant price, date, or amount is not numeric`);
      continue;
    }
    const grantDate = excelSerialToIsoDate(grantDateSerial);
    if (!grantDate) {
      warnings.push(`Skipped ESOP row ${r + 1}: invalid Excel date serial ${grantDateSerial}`);
      continue;
    }
    grants.push({
      id: `excel:${r + 1}`,
      grantPriceUsd: grantPrice,
      grantDate,
      amount,
      ...(unlocks.length > 0 ? { unlocks } : {}),
    });
  }
  if (grants.length === 0) warnings.push('No ESOP grant rows detected');
  return grants;
}

function parseAssumptions(
  values: RawCellValue[][],
  warnings: string[],
): EsopWorkbookParseResult['assumptions'] {
  const rateRowIndex = firstIndexOrDefault(findRowByLabel(values, '$/nis rate'), 11);
  const priceRowIndex = 12;
  const usdNisRate = asNumber(values[rateRowIndex]?.[3]);
  const currentPriceUsd = cellNumber(values, priceRowIndex, 3);
  const lockDownDays = Math.abs(findValueByLabel(values, 'lock down period') ?? cellNumber(values, 13, 3) ?? 730);
  const incomeTaxRate = findValueByLabel(values, 'income tax') ?? cellNumber(values, 14, 3);

  // Refresh timestamps live in the column immediately to the right of each value.
  const usdNisRateUpdatedAt = parseUpdatedAt(values[rateRowIndex]?.[4]);
  const currentPriceUsdUpdatedAt = parseUpdatedAt(values[priceRowIndex]?.[4]);

  const assumptions = {
    usdNisRate: usdNisRate ?? 0,
    currentPriceUsd: currentPriceUsd ?? 0,
    lockDownDays,
    incomeTaxRate: incomeTaxRate ?? 0,
    usdNisRateUpdatedAt,
    currentPriceUsdUpdatedAt,
  };

  if (usdNisRate === null) warnings.push('USD/NIS rate could not be parsed from ESOP sheet');
  if (currentPriceUsd === null) warnings.push('Current stock price could not be parsed from ESOP sheet');
  if (incomeTaxRate === null) warnings.push('Income tax rate could not be parsed from ESOP sheet');
  return assumptions;
}

function findRowByLabel(values: RawCellValue[][], label: string): number {
  for (let r = 0; r < values.length; r++) {
    if (normalizeHeader(values[r]?.[0]) === label) return r;
  }
  return -1;
}

function firstIndexOrDefault(index: number, fallback: number): number {
  return index >= 0 ? index : fallback;
}

/**
 * Read a "last updated" timestamp stored next to a market value. The API writes
 * it as an ISO string (text-formatted cell); older/foreign sheets may hold an
 * Excel datetime serial, so handle both.
 */
function parseUpdatedAt(value: RawCellValue | undefined): string | null {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return excelSerialToIsoDateTime(value);
  }
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (trimmed === '') return null;
    return Number.isNaN(Date.parse(trimmed)) ? null : trimmed;
  }
  return null;
}

function findValueByLabel(values: RawCellValue[][], label: string): number | null {
  for (const row of values) {
    const first = normalizeHeader(row[0]);
    if (first === label) {
      return asNumber(row[3]);
    }
  }
  return null;
}

function cellNumber(values: RawCellValue[][], rowIndex: number, columnIndex: number): number | null {
  return asNumber(values[rowIndex]?.[columnIndex]);
}

function asNumber(value: RawCellValue | undefined): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string' && value.trim() !== '') {
    const n = Number(value.replace(/,/g, ''));
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

function optionalAmount(value: RawCellValue | undefined): number | undefined {
  const amount = asNumber(value);
  return amount === null ? undefined : amount;
}

const MIN_UNLOCK_SERIAL = 40_000; // ~2009-07
const MAX_UNLOCK_SERIAL = 80_000; // ~2119

/**
 * An unlock column is any header (other than the grant price/date/amount
 * columns) that holds a date: an Excel date serial, or an explicit ISO date
 * string. The header's date is the tranche's vest date.
 */
function detectUnlockColumns(
  rawHeader: RawCellValue[],
  textHeader: RawCellValue[] | undefined,
  known: { grantPrice: number; grantDate: number; amount: number },
): { index: number; date: string }[] {
  const skip = new Set([known.grantPrice, known.grantDate, known.amount]);
  const unlocks: { index: number; date: string }[] = [];
  for (let c = 0; c < rawHeader.length; c++) {
    if (skip.has(c)) continue;
    const date = headerUnlockDate(rawHeader[c], textHeader?.[c]);
    if (date) unlocks.push({ index: c, date });
  }
  return unlocks;
}

function headerUnlockDate(
  rawValue: RawCellValue | undefined,
  textValue: RawCellValue | undefined,
): string | null {
  const serial = asNumber(rawValue);
  if (serial !== null && serial >= MIN_UNLOCK_SERIAL && serial <= MAX_UNLOCK_SERIAL) {
    const iso = excelSerialToIsoDate(serial);
    if (iso) return iso;
  }
  for (const candidate of [rawValue, textValue]) {
    if (typeof candidate === 'string') {
      const match = /(\d{4})-(\d{2})-(\d{2})/.exec(candidate.trim());
      if (match) return `${match[1]}-${match[2]}-${match[3]}`;
    }
  }
  return null;
}

function readGrantUnlocks(
  row: RawCellValue[],
  columns: { index: number; date: string }[],
): EsopUnlock[] {
  const unlocks: EsopUnlock[] = [];
  for (const column of columns) {
    const amount = optionalAmount(row[column.index]);
    if (amount !== undefined && amount > 0) unlocks.push({ date: column.date, amount });
  }
  return unlocks.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
}

export function excelSerialToIsoDate(serial: number): string | null {
  if (!Number.isFinite(serial)) return null;
  const millis = Math.round((serial - EXCEL_EPOCH_OFFSET) * MS_PER_DAY);
  const date = new Date(millis);
  if (!Number.isFinite(date.getTime())) return null;
  return date.toISOString().slice(0, 10);
}

export function excelSerialToIsoDateTime(serial: number): string | null {
  if (!Number.isFinite(serial)) return null;
  const millis = Math.round((serial - EXCEL_EPOCH_OFFSET) * MS_PER_DAY);
  const date = new Date(millis);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}

function normalizeHeader(value: RawCellValue | undefined): string {
  return value == null ? '' : String(value).trim().toLowerCase();
}

function emptyAssumptions(): EsopWorkbookParseResult['assumptions'] {
  return {
    usdNisRate: 0,
    currentPriceUsd: 0,
    lockDownDays: 730,
    incomeTaxRate: 0,
    usdNisRateUpdatedAt: null,
    currentPriceUsdUpdatedAt: null,
  };
}
