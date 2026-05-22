import type {
  EsopAssumptions,
  EsopCalculationResult,
  EsopComputedGrant,
  EsopGrant,
  EsopTotals,
  EsopUnblockForecast,
} from './types.js';

const CAPITAL_GAINS_TAX_RATE = 0.25;
const MS_PER_DAY = 86_400_000;

export function calculateEsop(
  grants: EsopGrant[],
  assumptions: EsopAssumptions,
): EsopCalculationResult {
  const warnings: string[] = [];
  const asOf = parseIsoDate(assumptions.asOf);
  if (!asOf) {
    throw new Error(`Invalid ESOP asOf date: ${assumptions.asOf}`);
  }

  const normalizedAssumptions: EsopAssumptions = {
    ...assumptions,
    lockDownDays: Math.abs(assumptions.lockDownDays),
  };

  const computed = grants.map((grant) =>
    calculateGrant(grant, normalizedAssumptions, asOf, warnings),
  );
  const totals = computeTotals(computed);
  const unblockForecasts = computeUnblockForecasts(grants, normalizedAssumptions, totals);
  return {
    assumptions: normalizedAssumptions,
    grants,
    computed,
    totals,
    unblockForecasts,
    warnings,
  };
}

function calculateGrant(
  grant: EsopGrant,
  assumptions: EsopAssumptions,
  asOf: Date,
  warnings: string[],
): EsopComputedGrant {
  const grantDate = parseIsoDate(grant.grantDate);
  if (!grantDate) {
    throw new Error(`Invalid ESOP grant date for ${grant.id}: ${grant.grantDate}`);
  }
  const ageDays = Math.floor((asOf.getTime() - grantDate.getTime()) / MS_PER_DAY);
  if (ageDays < 0) {
    warnings.push(`Grant ${grant.id} is dated after asOf (${grant.grantDate} > ${assumptions.asOf})`);
  }

  const grossNis = grant.amount * assumptions.usdNisRate * assumptions.currentPriceUsd;
  const incomeTaxNis = grant.amount * grant.grantPriceUsd * assumptions.usdNisRate * assumptions.incomeTaxRate;
  const stockTaxRate =
    ageDays >= assumptions.lockDownDays ? CAPITAL_GAINS_TAX_RATE : assumptions.incomeTaxRate;
  const stockTaxBase =
    grant.amount *
    (assumptions.currentPriceUsd - grant.grantPriceUsd) *
    assumptions.usdNisRate *
    stockTaxRate;
  const stockTaxNis = Math.max(0, stockTaxBase);
  const netNis = grossNis - incomeTaxNis - stockTaxNis;
  const effectiveTaxRate = grossNis === 0 ? null : 1 - netNis / grossNis;

  return {
    ...grant,
    ageDays,
    grossNis,
    incomeTaxNis,
    stockTaxNis,
    netNis,
    effectiveTaxRate,
    stockTaxRate,
  };
}

function computeTotals(rows: EsopComputedGrant[]): EsopTotals {
  const totals = rows.reduce(
    (acc, row) => ({
      grossNis: acc.grossNis + row.grossNis,
      incomeTaxNis: acc.incomeTaxNis + row.incomeTaxNis,
      stockTaxNis: acc.stockTaxNis + row.stockTaxNis,
      netNis: acc.netNis + row.netNis,
    }),
    { grossNis: 0, incomeTaxNis: 0, stockTaxNis: 0, netNis: 0 },
  );
  return {
    ...totals,
    effectiveTaxRate: totals.grossNis === 0 ? null : 1 - totals.netNis / totals.grossNis,
  };
}

function computeUnblockForecasts(
  grants: EsopGrant[],
  assumptions: EsopAssumptions,
  currentTotals: EsopTotals,
): EsopUnblockForecast[] {
  const may31Amount = sumUnblockAmounts(grants, 'unblockMay31Amount');
  const aug31Amount = sumUnblockAmounts(grants, 'unblockAug31Amount');
  if (may31Amount === 0 && aug31Amount === 0) return [];

  const may31Date = assumptions.unblockMay31Date ?? nextMilestoneDate(assumptions.asOf, 5, 31);
  const aug31Date = assumptions.unblockAug31Date ?? nextMilestoneDate(assumptions.asOf, 8, 31);
  const may31 = calculateForecastMilestone(
    grants,
    assumptions,
    may31Date,
    may31Amount,
    (grant) => grant.amount + (grant.unblockMay31Amount ?? 0),
  );
  const aug31 = calculateForecastMilestone(
    grants,
    assumptions,
    aug31Date,
    may31Amount + aug31Amount,
    (grant) => grant.amount + (grant.unblockMay31Amount ?? 0) + (grant.unblockAug31Amount ?? 0),
  );

  return [
    {
      id: 'may31',
      label: 'After May 31',
      asOf: may31Date,
      unlockedAmount: may31Amount,
      totalAmount: may31.totalAmount,
      sumNis: may31.totals.grossNis,
      netNis: may31.totals.netNis,
      sumDeltaNis: may31.totals.grossNis - currentTotals.grossNis,
      netDeltaNis: may31.totals.netNis - currentTotals.netNis,
    },
    {
      id: 'aug31',
      label: 'After Aug 31',
      asOf: aug31Date,
      unlockedAmount: may31Amount + aug31Amount,
      totalAmount: aug31.totalAmount,
      sumNis: aug31.totals.grossNis,
      netNis: aug31.totals.netNis,
      sumDeltaNis: aug31.totals.grossNis - currentTotals.grossNis,
      netDeltaNis: aug31.totals.netNis - currentTotals.netNis,
    },
  ];
}

function calculateForecastMilestone(
  grants: EsopGrant[],
  assumptions: EsopAssumptions,
  asOf: string,
  unlockedAmount: number,
  amountForGrant: (grant: EsopGrant) => number,
): { totals: EsopTotals; totalAmount: number } {
  const forecastGrants = unlockedAmount === 0 ? grants : grants.map((grant) => ({
    ...grant,
    amount: amountForGrant(grant),
  }));
  const date = parseIsoDate(asOf);
  if (!date) {
    throw new Error(`Invalid ESOP forecast date: ${asOf}`);
  }
  const warnings: string[] = [];
  const computed = forecastGrants.map((grant) =>
    calculateGrant(grant, { ...assumptions, asOf }, date, warnings),
  );
  const totals = computeTotals(computed);
  return { totals, totalAmount: sumAmounts(forecastGrants) };
}

function sumUnblockAmounts(
  grants: EsopGrant[],
  key: 'unblockMay31Amount' | 'unblockAug31Amount',
): number {
  return grants.reduce((sum, grant) => sum + (grant[key] ?? 0), 0);
}

function sumAmounts(grants: EsopGrant[]): number {
  return grants.reduce((sum, grant) => sum + grant.amount, 0);
}

function nextMilestoneDate(asOf: string, month: number, day: number): string {
  const year = Number(asOf.slice(0, 4));
  const candidate = isoDate(year, month, day);
  return candidate >= asOf ? candidate : isoDate(year + 1, month, day);
}

function isoDate(year: number, month: number, day: number): string {
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

function parseIsoDate(value: string): Date | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const date = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(date.getTime()) ? date : null;
}
