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

  const header = findHeader(values);
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

function findHeader(values: RawCellValue[][]): { rowIndex: number; columns: HeaderMap } | null {
  for (let r = 0; r < values.length; r++) {
    const normalized = values[r]?.map((cell) => normalizeHeader(cell)) ?? [];
    const hasRequired = REQUIRED_HEADERS.every((h) => normalized.includes(h));
    if (!hasRequired) continue;
    return {
      rowIndex: r,
      columns: {
        grantPrice: normalized.indexOf('grant price'),
        grantDate: normalized.indexOf('grant date'),
        amount: normalized.indexOf('amount'),
      },
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
