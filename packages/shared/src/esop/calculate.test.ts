import { describe, expect, it } from 'vitest';
import { calculateEsop } from './calculate.js';
import { parseEsopUsedRange } from './parseWorkbook.js';
import type { RawUsedRange } from '../parsers/usedRange.js';

const dumpedUsedRange: RawUsedRange = {
  address: 'ESOP!A1:K15',
  rowCount: 15,
  columnCount: 11,
  values: [
    ['Grant Price', 'Grant Date', '', 'Amount', 'Sum', 'Income Tax', 'Stock Tax', 'Net', 'Overall % Tax', 'Amount May31', 46265],
    [211.02, 44074, -2089.35300034722, 11, 13822.3514, 3817.24629, 1720.4759, 8284.62921, 0.400635320991767, 5, 5],
    [239.06, 44423, -1740.35300034722, 20, 25131.548, 7862.6834, 2708.94, 14559.9246, 0.420651501451482, 5, 5],
    [277.19, 44804, -1359.35300034722, 29, 36440.7446, 13219.329695, 3101.399925, 20120.01498, 0.447870365963927, 8, 7],
    [328.83, 45169, -994.353000347219, 38, 47749.9412, 20548.91553, 2597.06915, 24603.95652, 0.484733260362633, 10, 9],
    [416.8, 45535, -628.353000347219, 30, 37697.322, 20562.828, 170.699099999999, 16963.7949, 0.55, 7, 8],
    [515.35, 45900, -263.353000347219, 22, 27644.7028, 18644.84765, 0, 8999.85515, 0.67444558130681, 12, 11],
    ['', '', '', '', '', '', '', '', '', '', ''],
    ['', '', '', '', 0, 0, 0, 0, '#DIV/0!', '', ''],
    ['Sum', '', '', 60, 188486.61, 84655.850565, 10298.584075, 42964.56879, 0.77205506115262, '', ''],
    ['', '', '', '', '', '', '', 8999.85515, '', '', ''],
    ['$/NIS Rate', '', '', 2.99, '', '', '', '', '', '', ''],
    ['#VALUE!', '', '', 420.26, '', '', '', '', '', '', ''],
    ['Lock down period', '', '', -730, '', '', '', '', '', '', ''],
    ['Income Tax', '', '', 0.55, '', '', '', '', '', '', ''],
  ],
};

describe('parseEsopUsedRange', () => {
  it('parses grant rows and assumptions without reading broken totals', () => {
    const parsed = parseEsopUsedRange(dumpedUsedRange);
    expect(parsed.warnings).toEqual([]);
    expect(parsed.assumptions).toEqual({
      usdNisRate: 2.99,
      currentPriceUsd: 420.26,
      lockDownDays: 730,
      incomeTaxRate: 0.55,
    });
    expect(parsed.grants).toHaveLength(6);
    expect(parsed.grants[0]).toEqual({
      id: 'excel:2',
      grantPriceUsd: 211.02,
      grantDate: '2020-08-31',
      amount: 11,
    });
  });
});

describe('calculateEsop', () => {
  it('reproduces the workbook row calculations with positive ageDays', () => {
    const parsed = parseEsopUsedRange(dumpedUsedRange);
    const result = calculateEsop(parsed.grants, {
      ...parsed.assumptions,
      asOf: '2026-06-20',
    });

    expect(result.computed[0]?.ageDays).toBeGreaterThan(730);
    expect(result.computed[0]?.stockTaxRate).toBe(0.25);
    expect(result.computed[4]?.ageDays).toBeLessThan(730);
    expect(result.computed[4]?.stockTaxRate).toBe(0.55);
    expect(result.computed[0]?.grossNis).toBeCloseTo(13822.3514, 6);
    expect(result.computed[0]?.incomeTaxNis).toBeCloseTo(3817.24629, 6);
    expect(result.computed[0]?.stockTaxNis).toBeCloseTo(1720.4759, 6);
    expect(result.computed[0]?.netNis).toBeCloseTo(8284.62921, 6);
    expect(result.computed[0]?.effectiveTaxRate).toBeCloseTo(0.400635320991767, 12);
  });

  it('returns null effective tax rates when gross proceeds are zero', () => {
    const result = calculateEsop(
      [{ id: 'g1', grantDate: '2024-01-01', grantPriceUsd: 10, amount: 0 }],
      {
        usdNisRate: 3.5,
        currentPriceUsd: 100,
        lockDownDays: 730,
        incomeTaxRate: 0.5,
        asOf: '2026-01-01',
      },
    );
    expect(result.computed[0]?.effectiveTaxRate).toBeNull();
    expect(result.totals.effectiveTaxRate).toBeNull();
  });
});
