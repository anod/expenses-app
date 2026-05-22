import type { RawCellValue } from '../contracts/types.js';
import type { RawUsedRange } from '../parsers/usedRange.js';
import type { EsopGrant, EsopWorkbookParseResult } from './types.js';

const REQUIRED_HEADERS = ['grant price', 'grant date', 'amount'];
const EXCEL_EPOCH_OFFSET = 25_569;
const MS_PER_DAY = 86_400_000;

interface HeaderMap {
  grantPrice: number;
  grantDate: number;
  amount: number;
  unblockMay31?: number;
  unblockAug31?: number;
  unblockMay31Date?: string;
  unblockAug31Date?: string;
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
  const assumptions = {
    ...parseAssumptions(values, warnings),
    ...unblockDates(header.columns),
  };
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
    const columns: HeaderMap = {
      grantPrice: normalized.indexOf('grant price'),
      grantDate: normalized.indexOf('grant date'),
      amount: normalized.indexOf('amount'),
    };
    const unblockMay31 = findMay31Column(normalized, rawHeader);
    const unblockAug31 = findAug31Column(normalized, rawHeader);
    if (unblockMay31) {
      columns.unblockMay31 = unblockMay31.index;
      if (unblockMay31.date) columns.unblockMay31Date = unblockMay31.date;
    }
    if (unblockAug31) {
      columns.unblockAug31 = unblockAug31.index;
      if (unblockAug31.date) columns.unblockAug31Date = unblockAug31.date;
    }
    if (!columns.unblockMay31Date && columns.unblockAug31Date) {
      columns.unblockMay31Date = `${columns.unblockAug31Date.slice(0, 4)}-05-31`;
    }
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
    const unblockMay31Amount = optionalAmount(row[columns.unblockMay31 ?? -1]);
    const unblockAug31Amount = optionalAmount(row[columns.unblockAug31 ?? -1]);
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
      ...(unblockMay31Amount !== undefined ? { unblockMay31Amount } : {}),
      ...(unblockAug31Amount !== undefined ? { unblockAug31Amount } : {}),
    });
  }
  if (grants.length === 0) warnings.push('No ESOP grant rows detected');
  return grants;
}

function parseAssumptions(
  values: RawCellValue[][],
  warnings: string[],
): EsopWorkbookParseResult['assumptions'] {
  const usdNisRate = findValueByLabel(values, '$/nis rate') ?? cellNumber(values, 11, 3);
  const currentPriceUsd = cellNumber(values, 12, 3);
  const lockDownDays = Math.abs(findValueByLabel(values, 'lock down period') ?? cellNumber(values, 13, 3) ?? 730);
  const incomeTaxRate = findValueByLabel(values, 'income tax') ?? cellNumber(values, 14, 3);

  const assumptions = {
    usdNisRate: usdNisRate ?? 0,
    currentPriceUsd: currentPriceUsd ?? 0,
    lockDownDays,
    incomeTaxRate: incomeTaxRate ?? 0,
  };

  if (usdNisRate === null) warnings.push('USD/NIS rate could not be parsed from ESOP sheet');
  if (currentPriceUsd === null) warnings.push('Current stock price could not be parsed from ESOP sheet');
  if (incomeTaxRate === null) warnings.push('Income tax rate could not be parsed from ESOP sheet');
  return assumptions;
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

function findMay31Column(
  normalized: string[],
  rawHeader: RawCellValue[],
): { index: number; date?: string } | null {
  const textIndex = normalized.findIndex((header) => {
    const compact = header.replace(/\s/g, '');
    return compact.includes('may31') || compact.includes('31-may') || compact.includes('31may');
  });
  if (textIndex >= 0) return { index: textIndex };
  return findDateSerialColumn(rawHeader, '05-31');
}

function findAug31Column(
  normalized: string[],
  rawHeader: RawCellValue[],
): { index: number; date?: string } | null {
  const textIndex = normalized.findIndex((header) => {
    const compact = header.replace(/\s/g, '');
    return compact.includes('aug31') || compact.includes('31-aug') || compact.includes('31aug');
  });
  if (textIndex >= 0) return { index: textIndex };
  return findDateSerialColumn(rawHeader, '08-31');
}

function findDateSerialColumn(
  rawHeader: RawCellValue[],
  monthDay: '05-31' | '08-31',
): { index: number; date?: string } | null {
  const serialIndex = rawHeader.findIndex((header) => {
    const serial = asNumber(header);
    if (serial === null) return false;
    const date = excelSerialToIsoDate(serial);
    return date?.slice(5) === monthDay;
  });
  if (serialIndex < 0) return null;
  const date = excelSerialToIsoDate(asNumber(rawHeader[serialIndex]) ?? 0);
  return date ? { index: serialIndex, date } : { index: serialIndex };
}

function unblockDates(columns: HeaderMap): {
  unblockMay31Date?: string;
  unblockAug31Date?: string;
} {
  const dates: { unblockMay31Date?: string; unblockAug31Date?: string } = {};
  if (columns.unblockMay31Date) dates.unblockMay31Date = columns.unblockMay31Date;
  if (columns.unblockAug31Date) dates.unblockAug31Date = columns.unblockAug31Date;
  return dates;
}

export function excelSerialToIsoDate(serial: number): string | null {
  if (!Number.isFinite(serial)) return null;
  const millis = Math.round((serial - EXCEL_EPOCH_OFFSET) * MS_PER_DAY);
  const date = new Date(millis);
  if (!Number.isFinite(date.getTime())) return null;
  return date.toISOString().slice(0, 10);
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
  };
}
