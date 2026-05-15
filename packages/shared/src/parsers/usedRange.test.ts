import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseWorkbookDump, normalizeMonthLabel } from '../parsers/usedRange.js';
import { parseCurrencyFormat } from '../parsers/currency.js';
import type { RawWorkbookDump } from '../parsers/usedRange.js';

function loadLatestDump(): RawWorkbookDump {
  // dumps/ lives at the repo root (two levels up from this file's package).
  const dumpsDir = resolve(__dirname, '../../../../dumps');
  const files = readdirSync(dumpsDir).filter((f) => f.startsWith('dump-') && f.endsWith('.json')).sort();
  const latest = files[files.length - 1];
  if (!latest) throw new Error('No dump file found in dumps/');
  return JSON.parse(readFileSync(resolve(dumpsDir, latest), 'utf8')) as RawWorkbookDump;
}

describe('normalizeMonthLabel', () => {
  it('parses "10-May-26" → "2026-05-10"', () => {
    expect(normalizeMonthLabel('10-May-26')).toBe('2026-05-10');
  });
  it('parses "10-Jan-27" → "2027-01-10"', () => {
    expect(normalizeMonthLabel('10-Jan-27')).toBe('2027-01-10');
  });
  it('returns the original string for unrecognized input', () => {
    expect(normalizeMonthLabel('foo')).toBe('foo');
  });
});

describe('parseCurrencyFormat', () => {
  it('parses Israeli Shekel format', () => {
    const r = parseCurrencyFormat('[$₪-he-IL] #,##0;[Red][$₪-he-IL] -#,##0');
    expect(r.code).toBe('ILS');
    expect(r.symbol).toBe('₪');
    expect(r.locale).toBe('he-IL');
  });
  it('parses ISO code in brackets', () => {
    const r = parseCurrencyFormat('[$USD-en-US] #,##0.00');
    expect(r.code).toBe('USD');
    expect(r.locale).toBe('en-US');
  });
  it('returns nulls for non-currency formats', () => {
    expect(parseCurrencyFormat('General').code).toBeNull();
    expect(parseCurrencyFormat(null).code).toBeNull();
  });
});

describe('parseWorkbookDump (live data)', () => {
  const snapshot = parseWorkbookDump(loadLatestDump(), { fetchedAt: '2026-05-15T20:00:00Z' });

  it('detects 9 month columns starting in May 2026', () => {
    expect(snapshot.months).toHaveLength(9);
    expect(snapshot.months[0]).toEqual({ key: '2026-05-10', label: '10-May-26', columnIndex: 3 });
    expect(snapshot.months.at(-1)).toEqual({ key: '2027-01-10', label: '10-Jan-27', columnIndex: 11 });
  });

  it('detects ILS currency from balance-row numberFormat', () => {
    expect(snapshot.workbook.currency.code).toBe('ILS');
    expect(snapshot.workbook.currency.symbol).toBe('₪');
    expect(snapshot.workbook.currency.locale).toBe('he-IL');
  });

  it('detects the balance row via SUM formulas (not via label)', () => {
    expect(snapshot.balanceRow).not.toBeNull();
    expect(snapshot.balanceRow!.kind).toBe('balance');
    expect(snapshot.balanceRow!.labelTrimmed).toBe('счет');
    // May value is a literal starting balance.
    expect(snapshot.balanceRow!.amounts['2026-05-10']!.value).toBe(29900);
    expect(snapshot.balanceRow!.amounts['2026-05-10']!.isFormula).toBe(false);
    // Subsequent months are formulas.
    expect(snapshot.balanceRow!.amounts['2026-06-10']!.isFormula).toBe(true);
    expect(snapshot.balanceRow!.amounts['2026-06-10']!.formula).toMatch(/^=SUM\(/i);
  });

  it('excludes the balance row from rows[]', () => {
    for (const row of snapshot.rows) {
      expect(row.kind).not.toBe('balance');
    }
  });

  it('detects user-authored amount formulas', () => {
    const calDebt = snapshot.rows.find((r) => r.labelTrimmed === 'cal debt');
    expect(calDebt).toBeDefined();
    // June is the first month with an authored formula on this row.
    const jun = calDebt!.amounts['2026-06-10']!;
    expect(jun.isFormula).toBe(true);
    expect(jun.formula).toBe('=-308-333-395');
    expect(jun.value).toBe(-1036); // formula result
    // May is a literal 0.
    const may = calDebt!.amounts['2026-05-10']!;
    expect(may.isFormula).toBe(false);
    expect(may.value).toBe(0);
  });

  it('coerces blank cells to null', () => {
    const water = snapshot.rows.find((r) => r.labelTrimmed === 'вода');
    expect(water).toBeDefined();
    expect(water!.amounts['2026-05-10']!.value).toBeNull();
    expect(water!.amounts['2026-06-10']!.value).toBe(-132);
    expect(water!.amounts['2026-07-10']!.value).toBeNull();
  });

  it('preserves multilingual labels and trailing whitespace', () => {
    const menora = snapshot.rows.find((r) => r.labelTrimmed === 'менора страховки');
    expect(menora).toBeDefined();
    expect(menora!.label).toBe('менора страховки '); // trailing space preserved
  });

  it('classifies "карта остаток" as a derived row', () => {
    const ostatok = snapshot.rows.find((r) => r.labelTrimmed === 'карта остаток');
    expect(ostatok).toBeDefined();
    expect(ostatok!.kind).toBe('derived');
  });

  it('parses the salary row as positive numbers, expense rows as negative', () => {
    const salary = snapshot.rows.find((r) => r.labelTrimmed === 'зп');
    expect(salary?.amounts['2026-05-10']?.value).toBe(26000);
    const sber = snapshot.rows.find((r) => r.labelTrimmed === 'сбер');
    expect(sber?.amounts['2026-05-10']?.value).toBe(-2000);
  });

  it('captures source values', () => {
    const sources = new Set(snapshot.rows.map((r) => r.source));
    expect(sources.has('cal')).toBe(true);
    expect(sources.has('onezero')).toBe(true);
    expect(sources.has('isra')).toBe(true);
    expect(sources.has('')).toBe(true);
  });

  it('captures workbook metadata', () => {
    expect(snapshot.workbook.name).toBe('Expenses.xlsx');
    expect(snapshot.workbook.range).toBe('Sheet1!A1:L22');
    expect(snapshot.workbook.rowCount).toBe(22);
    expect(snapshot.workbook.columnCount).toBe(12);
  });

  it('returns no fatal warnings for the live dump', () => {
    expect(snapshot.warnings).toEqual([]);
  });
});
