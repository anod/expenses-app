import { describe, expect, it } from 'vitest';
import { calculateEsop } from './calculate.js';
import { parseEsopUsedRange } from './parseWorkbook.js';
import type { EsopGrant } from './types.js';
import type { RawUsedRange } from '../parsers/usedRange.js';

/** Excel date serial for an ISO date (mirrors excelSerialToIsoDate's epoch). */
function serial(iso: string): number {
  const [y, m, d] = iso.split('-').map(Number);
  return Math.round(Date.UTC(y, m - 1, d) / 86_400_000) + 25_569;
}

const dumpedUsedRange: RawUsedRange = {
  address: 'ESOP!A1:K15',
  rowCount: 15,
  columnCount: 11,
  values: [
    ['Grant Price', 'Grant Date', '', 'Amount', 'Sum', 'Income Tax', 'Stock Tax', 'Net', 'Overall % Tax', serial('2026-05-31'), serial('2026-08-31')],
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
      usdNisRateUpdatedAt: null,
      currentPriceUsdUpdatedAt: null,
    });
    expect(parsed.grants).toHaveLength(6);
    expect(parsed.grants[0]).toEqual({
      id: 'excel:2',
      grantPriceUsd: 211.02,
      grantDate: '2020-08-31',
      amount: 11,
      unlocks: [
        { date: '2026-05-31', amount: 5 },
        { date: '2026-08-31', amount: 5 },
      ],
    });
  });

  it('reads refresh timestamps stored next to the market values', () => {
    const withTimestamps: RawUsedRange = {
      ...dumpedUsedRange,
      values: dumpedUsedRange.values.map((row, r) => {
        if (r === 11) return ['$/NIS Rate', '', '', 2.99, '2026-08-03T06:30:00.000Z', '', '', '', '', '', ''];
        if (r === 12) return ['#VALUE!', '', '', 420.26, '2026-08-03T06:31:00.000Z', '', '', '', '', '', ''];
        return row;
      }),
    };
    const parsed = parseEsopUsedRange(withTimestamps);
    expect(parsed.assumptions.usdNisRateUpdatedAt).toBe('2026-08-03T06:30:00.000Z');
    expect(parsed.assumptions.currentPriceUsdUpdatedAt).toBe('2026-08-03T06:31:00.000Z');
  });
});

describe('calculateEsop', () => {
  it('reproduces the workbook row calculations before any unlock date', () => {
    const parsed = parseEsopUsedRange(dumpedUsedRange);
    const result = calculateEsop(parsed.grants, {
      ...parsed.assumptions,
      asOf: '2026-05-01',
    });

    expect(result.computed[0]?.ageDays).toBeGreaterThan(730);
    expect(result.computed[0]?.stockTaxRate).toBe(0.25);
    expect(result.computed[0]?.heldAmount).toBe(11);
    expect(result.computed[4]?.ageDays).toBeLessThan(730);
    expect(result.computed[4]?.stockTaxRate).toBe(0.55);
    expect(result.computed[0]?.grossNis).toBeCloseTo(13822.3514, 6);
    expect(result.computed[0]?.incomeTaxNis).toBeCloseTo(3817.24629, 6);
    expect(result.computed[0]?.stockTaxNis).toBeCloseTo(1720.4759, 6);
    expect(result.computed[0]?.netNis).toBeCloseTo(8284.62921, 6);
    expect(result.computed[0]?.effectiveTaxRate).toBeCloseTo(0.400635320991767, 12);
    expect(result.pastUnlocks).toEqual([]);
    expect(result.unblockForecasts).toHaveLength(2);
    expect(result.unblockForecasts[0]).toMatchObject({
      date: '2026-05-31',
      label: 'After May 31, 2026',
      unlockedAmount: 47,
      totalAmount: 197,
    });
    expect(result.unblockForecasts[1]).toMatchObject({
      date: '2026-08-31',
      label: 'After Aug 31, 2026',
      unlockedAmount: 92,
      totalAmount: 242,
    });
    expect(result.unblockForecasts[0]?.sumDeltaNis).toBeCloseTo(59059.1378, 6);
    expect(result.unblockForecasts[1]?.sumDeltaNis).toBeCloseTo(115605.1208, 6);
  });

  it('folds a passed unlock date into current holdings and forecasts only the future one', () => {
    const parsed = parseEsopUsedRange(dumpedUsedRange);
    // 2026-06-20 is after the May 31 unlock but before the Aug 31 unlock.
    const result = calculateEsop(parsed.grants, {
      ...parsed.assumptions,
      asOf: '2026-06-20',
    });

    // May 31 shares are now held: grant 0 is 11 + 5 = 16.
    expect(result.computed[0]?.heldAmount).toBe(16);
    expect(result.computed[0]?.grossNis).toBeCloseTo(16 * 2.99 * 420.26, 6);

    expect(result.pastUnlocks).toEqual([
      { date: '2026-05-31', label: 'May 31, 2026', amount: 47 },
    ]);

    expect(result.unblockForecasts).toHaveLength(1);
    expect(result.unblockForecasts[0]).toMatchObject({
      date: '2026-08-31',
      label: 'After Aug 31, 2026',
      unlockedAmount: 45,
      totalAmount: 242,
    });
    // Delta is measured against current holdings (which already include May 31).
    expect(result.unblockForecasts[0]?.sumDeltaNis).toBeCloseTo(45 * 2.99 * 420.26, 6);
    expect(result.unblockForecasts[0]?.netDeltaNis).toBeGreaterThan(0);
  });

  it('folds every passed unlock date and emits no forecast when all have vested', () => {
    const parsed = parseEsopUsedRange(dumpedUsedRange);
    const result = calculateEsop(parsed.grants, {
      ...parsed.assumptions,
      asOf: '2026-09-15',
    });

    expect(result.computed[0]?.heldAmount).toBe(21); // 11 + 5 + 5
    expect(result.pastUnlocks).toEqual([
      { date: '2026-05-31', label: 'May 31, 2026', amount: 47 },
      { date: '2026-08-31', label: 'Aug 31, 2026', amount: 45 },
    ]);
    expect(result.unblockForecasts).toEqual([]);
  });

  it('forecasts unlock dates across multiple years from the column dates', () => {
    const grants: EsopGrant[] = [
      {
        id: 'g1',
        grantDate: '2020-01-01',
        grantPriceUsd: 100,
        amount: 0,
        unlocks: [
          { date: '2026-05-31', amount: 10 },
          { date: '2026-08-31', amount: 10 },
          { date: '2027-05-31', amount: 10 },
          { date: '2027-08-31', amount: 10 },
        ],
      },
    ];
    const result = calculateEsop(grants, {
      usdNisRate: 4,
      currentPriceUsd: 200,
      lockDownDays: 730,
      incomeTaxRate: 0.5,
      asOf: '2026-01-01',
    });

    expect(result.pastUnlocks).toEqual([]);
    expect(result.unblockForecasts.map((f) => f.date)).toEqual([
      '2026-05-31',
      '2026-08-31',
      '2027-05-31',
      '2027-08-31',
    ]);
    expect(result.unblockForecasts.map((f) => f.label)).toEqual([
      'After May 31, 2026',
      'After Aug 31, 2026',
      'After May 31, 2027',
      'After Aug 31, 2027',
    ]);
    // Cumulative unlocked amounts across both years.
    expect(result.unblockForecasts.map((f) => f.unlockedAmount)).toEqual([10, 20, 30, 40]);
    expect(result.unblockForecasts.map((f) => f.totalAmount)).toEqual([10, 20, 30, 40]);
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
    expect(result.pastUnlocks).toEqual([]);
    expect(result.unblockForecasts).toEqual([]);
  });
});

/**
 * First-principles NIS net for a grant at a given held amount, deliberately
 * re-derived here (not by calling calculate.ts) so these tests catch a real
 * divergence in the engine's per-grant math rather than tautologically
 * agreeing with it. Mirrors the workbook formula: gross − income tax − stock
 * tax, with the stock-tax rate switching to capital gains once the grant is
 * older than the lock-down period on the valuation date.
 */
function grantNet(
  grant: EsopGrant,
  held: number,
  assumptions: { usdNisRate: number; currentPriceUsd: number; lockDownDays: number; incomeTaxRate: number },
  valuationIso: string,
): number {
  const CAPITAL_GAINS = 0.25;
  const MS_PER_DAY = 86_400_000;
  const ageDays = Math.floor(
    (Date.parse(`${valuationIso}T00:00:00.000Z`) - Date.parse(`${grant.grantDate}T00:00:00.000Z`)) / MS_PER_DAY,
  );
  const gross = held * assumptions.usdNisRate * assumptions.currentPriceUsd;
  const incomeTax = held * grant.grantPriceUsd * assumptions.usdNisRate * assumptions.incomeTaxRate;
  const stockRate = ageDays >= assumptions.lockDownDays ? CAPITAL_GAINS : assumptions.incomeTaxRate;
  const stockTax = Math.max(0, held * (assumptions.currentPriceUsd - grant.grantPriceUsd) * assumptions.usdNisRate * stockRate);
  return gross - incomeTax - stockTax;
}

/** Shares held on `asOf`: the base amount plus every unlock already vested. */
function heldOn(grant: EsopGrant, asOf: string): number {
  return grant.amount + (grant.unlocks ?? []).filter((u) => u.date <= asOf).reduce((s, u) => s + u.amount, 0);
}

/** Shares that unlock strictly after `asOf` and on or before `through`. */
function unlockedBetween(grant: EsopGrant, asOf: string, through: string): number {
  return (grant.unlocks ?? [])
    .filter((u) => u.date > asOf && u.date <= through)
    .reduce((s, u) => s + u.amount, 0);
}

describe('grants total and forecast pill consistency', () => {
  // Mixed grant prices and ages on purpose: a grant that is already past the
  // lock-down window (2019) and one that only crosses it partway through the
  // forecast horizon (2024). This guarantees the pill cannot be reproduced by a
  // naive "total shares × one net-per-share" scaling — it must be a true
  // per-grant sum — so the test has teeth.
  const GRANTS: EsopGrant[] = [
    {
      id: 'old',
      grantDate: '2019-01-01',
      grantPriceUsd: 100,
      amount: 10,
      unlocks: [
        { date: '2026-08-31', amount: 3 },
        { date: '2026-11-30', amount: 3 },
        { date: '2027-02-28', amount: 3 },
      ],
    },
    {
      id: 'mid',
      grantDate: '2024-11-15',
      grantPriceUsd: 300,
      amount: 8,
      unlocks: [
        { date: '2026-08-31', amount: 2 },
        { date: '2026-11-30', amount: 2 },
        { date: '2027-02-28', amount: 2 },
      ],
    },
  ];
  const ASSUMPTIONS = {
    usdNisRate: 3.7,
    currentPriceUsd: 430,
    lockDownDays: 730,
    incomeTaxRate: 0.55,
    asOf: '2026-08-03',
  };

  it('current totals equal the sum of the per-grant rows', () => {
    const result = calculateEsop(GRANTS, ASSUMPTIONS);
    const sum = (pick: (r: (typeof result.computed)[number]) => number) =>
      result.computed.reduce((acc, row) => acc + pick(row), 0);

    expect(result.totals.grossNis).toBeCloseTo(sum((r) => r.grossNis), 6);
    expect(result.totals.incomeTaxNis).toBeCloseTo(sum((r) => r.incomeTaxNis), 6);
    expect(result.totals.stockTaxNis).toBeCloseTo(sum((r) => r.stockTaxNis), 6);
    expect(result.totals.netNis).toBeCloseTo(sum((r) => r.netNis), 6);
  });

  it('each forecast pill equals the grants revalued and summed at that unlock date', () => {
    const result = calculateEsop(GRANTS, ASSUMPTIONS);
    expect(result.unblockForecasts.length).toBe(3);

    for (const forecast of result.unblockForecasts) {
      let shares = 0;
      let gross = 0;
      let net = 0;
      for (const grant of GRANTS) {
        const held = heldOn(grant, ASSUMPTIONS.asOf) + unlockedBetween(grant, ASSUMPTIONS.asOf, forecast.date);
        shares += held;
        gross += held * ASSUMPTIONS.usdNisRate * ASSUMPTIONS.currentPriceUsd;
        net += grantNet(grant, held, ASSUMPTIONS, forecast.date);
      }
      expect(forecast.totalAmount).toBe(shares);
      expect(forecast.sumNis).toBeCloseTo(gross, 6);
      expect(forecast.netNis).toBeCloseTo(net, 6);
    }
  });

  it('forecast net is a true per-grant sum, not a flat per-share scaling', () => {
    const result = calculateEsop(GRANTS, ASSUMPTIONS);
    const currentShares = result.computed.reduce((s, r) => s + r.heldAmount, 0);
    const netPerShareNow = result.totals.netNis / currentShares;

    // A naive forecast (total shares × current net-per-share) diverges from the
    // real per-grant revaluation; assert the engine does NOT take that shortcut.
    const last = result.unblockForecasts.at(-1)!;
    const naive = last.totalAmount * netPerShareNow;
    expect(Math.abs(last.netNis - naive)).toBeGreaterThan(1);
  });
});

describe('reshaped workbook: unlock folded into Amount, extra forecast columns', () => {
  // Mirrors the user's edit: the earliest (already-vested) tranche is merged
  // into the Amount column and no longer has its own column, while two more
  // dated forecast columns (Nov, Feb) are added alongside the existing Aug one.
  const reshaped: RawUsedRange = {
    address: 'ESOP!A1:L15',
    rowCount: 15,
    columnCount: 12,
    values: [
      ['Grant Price', 'Grant Date', '', 'Amount', 'Sum', 'Income Tax', 'Stock Tax', 'Net', 'Overall % Tax', serial('2026-08-31'), serial('2026-11-30'), serial('2027-02-28')],
      [211.02, 44074, -2089.35, 16, '', '', '', '', '', 5, 5, 5],
      [239.06, 44423, -1740.35, 25, '', '', '', '', '', 5, 5, 5],
      [277.19, 44804, -1359.35, 34, '', '', '', '', '', 8, 7, 7],
      ['', '', '', '', '', '', '', '', '', '', '', ''],
      ['Sum', '', '', 75, '', '', '', '', '', '', '', ''],
      ['', '', '', '', '', '', '', '', '', '', '', ''],
      ['', '', '', '', '', '', '', '', '', '', '', ''],
      ['', '', '', '', '', '', '', '', '', '', '', ''],
      ['', '', '', '', '', '', '', '', '', '', '', ''],
      ['', '', '', '', '', '', '', '', '', '', '', ''],
      ['$/NIS Rate', '', '', 2.99, '', '', '', '', '', '', '', ''],
      ['#VALUE!', '', '', 420.26, '', '', '', '', '', '', '', ''],
      ['Lock down period', '', '', -730, '', '', '', '', '', '', '', ''],
      ['Income Tax', '', '', 0.55, '', '', '', '', '', '', '', ''],
    ],
  };

  it('parses the merged Amount and all three dated forecast columns', () => {
    const parsed = parseEsopUsedRange(reshaped);
    expect(parsed.warnings).toEqual([]);
    expect(parsed.grants).toHaveLength(3);
    expect(parsed.grants[0]).toEqual({
      id: 'excel:2',
      grantPriceUsd: 211.02,
      grantDate: '2020-08-31',
      amount: 16,
      unlocks: [
        { date: '2026-08-31', amount: 5 },
        { date: '2026-11-30', amount: 5 },
        { date: '2027-02-28', amount: 5 },
      ],
    });
  });

  it('forecasts Aug/Nov/Feb with consistent, per-grant-summed net before any unlock', () => {
    const parsed = parseEsopUsedRange(reshaped);
    const assumptions = { ...parsed.assumptions, asOf: '2026-08-03' };
    const result = calculateEsop(parsed.grants, assumptions);

    // Nothing has vested yet at asOf, so Amount is held as-is and there are no
    // folded past unlocks (the May tranche now lives inside Amount).
    expect(result.pastUnlocks).toEqual([]);
    expect(result.computed[0]?.heldAmount).toBe(16);

    expect(result.unblockForecasts.map((f) => f.label)).toEqual([
      'After Aug 31, 2026',
      'After Nov 30, 2026',
      'After Feb 28, 2027',
    ]);
    // Cumulative shares unlocked across the three dates: 18, then 35, then 52.
    expect(result.unblockForecasts.map((f) => f.unlockedAmount)).toEqual([18, 35, 52]);

    for (const forecast of result.unblockForecasts) {
      const net = parsed.grants.reduce(
        (sum, grant) => sum + grantNet(grant, heldOn(grant, assumptions.asOf) + unlockedBetween(grant, assumptions.asOf, forecast.date), assumptions, forecast.date),
        0,
      );
      expect(forecast.netNis).toBeCloseTo(net, 6);
    }
  });
});
