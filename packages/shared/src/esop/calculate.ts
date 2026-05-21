import type {
  EsopAssumptions,
  EsopCalculationResult,
  EsopComputedGrant,
  EsopGrant,
  EsopTotals,
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
  return {
    assumptions: normalizedAssumptions,
    grants,
    computed,
    totals,
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

function parseIsoDate(value: string): Date | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const date = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(date.getTime()) ? date : null;
}
