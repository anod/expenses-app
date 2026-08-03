import type {
  EsopAssumptions,
  EsopCalculationResult,
  EsopComputedGrant,
  EsopGrant,
  EsopPastUnlock,
  EsopTotals,
  EsopUnblockForecast,
} from './types.js';

const CAPITAL_GAINS_TAX_RATE = 0.25;
const MS_PER_DAY = 86_400_000;

/**
 * A share-unlock milestone (May 31 / Aug 31). `date` is the resolved ISO date
 * the shares vest on; `amountOf` returns the shares a given grant unlocks then.
 */
interface Milestone {
  id: 'may31' | 'aug31';
  forecastLabel: string;
  shortLabel: string;
  date: string;
  amountOf: (grant: EsopGrant) => number;
}

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

  const milestones = buildMilestones(grants, normalizedAssumptions);
  // A milestone whose date is on or before `asOf` has already vested, so its
  // shares are folded into current holdings instead of shown as a forecast.
  const passed = milestones.filter((m) => m.date <= normalizedAssumptions.asOf);
  const future = milestones.filter((m) => m.date > normalizedAssumptions.asOf);

  const heldAmountOf = (grant: EsopGrant): number =>
    grant.amount + passed.reduce((sum, m) => sum + m.amountOf(grant), 0);

  const computed = grants.map((grant) =>
    valueGrant(grant, heldAmountOf(grant), normalizedAssumptions, asOf, warnings),
  );
  const totals = computeTotals(computed);

  const pastUnlocks: EsopPastUnlock[] = passed.map((m) => ({
    id: m.id,
    label: m.shortLabel,
    date: m.date,
    amount: sumMilestone(grants, m),
  }));

  const unblockForecasts = computeUnblockForecasts(
    grants,
    normalizedAssumptions,
    heldAmountOf,
    future,
    totals,
  );

  return {
    assumptions: normalizedAssumptions,
    grants,
    computed,
    totals,
    unblockForecasts,
    pastUnlocks,
    warnings,
  };
}

/**
 * Value a grant at a specific `heldAmount` (current holdings or a forecast
 * amount). Gross/tax scale with `heldAmount`; `grant.amount` is preserved as
 * the original granted quantity.
 */
function valueGrant(
  grant: EsopGrant,
  heldAmount: number,
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

  const grossNis = heldAmount * assumptions.usdNisRate * assumptions.currentPriceUsd;
  const incomeTaxNis =
    heldAmount * grant.grantPriceUsd * assumptions.usdNisRate * assumptions.incomeTaxRate;
  const stockTaxRate =
    ageDays >= assumptions.lockDownDays ? CAPITAL_GAINS_TAX_RATE : assumptions.incomeTaxRate;
  const stockTaxBase =
    heldAmount *
    (assumptions.currentPriceUsd - grant.grantPriceUsd) *
    assumptions.usdNisRate *
    stockTaxRate;
  const stockTaxNis = Math.max(0, stockTaxBase);
  const netNis = grossNis - incomeTaxNis - stockTaxNis;
  const effectiveTaxRate = grossNis === 0 ? null : 1 - netNis / grossNis;

  return {
    ...grant,
    ageDays,
    heldAmount,
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

function buildMilestones(grants: EsopGrant[], assumptions: EsopAssumptions): Milestone[] {
  const may31Total = sumUnblockAmounts(grants, 'unblockMay31Amount');
  const aug31Total = sumUnblockAmounts(grants, 'unblockAug31Amount');
  const milestones: Milestone[] = [];
  if (may31Total > 0) {
    milestones.push({
      id: 'may31',
      forecastLabel: 'After May 31',
      shortLabel: 'May 31',
      date: assumptions.unblockMay31Date ?? nextMilestoneDate(assumptions.asOf, 5, 31),
      amountOf: (grant) => grant.unblockMay31Amount ?? 0,
    });
  }
  if (aug31Total > 0) {
    milestones.push({
      id: 'aug31',
      forecastLabel: 'After Aug 31',
      shortLabel: 'Aug 31',
      date: assumptions.unblockAug31Date ?? nextMilestoneDate(assumptions.asOf, 8, 31),
      amountOf: (grant) => grant.unblockAug31Amount ?? 0,
    });
  }
  return milestones.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
}

/**
 * One forecast per still-future milestone, applied cumulatively on top of
 * current holdings (which already include any passed milestones). Deltas are
 * measured against the current totals.
 */
function computeUnblockForecasts(
  grants: EsopGrant[],
  assumptions: EsopAssumptions,
  heldAmountOf: (grant: EsopGrant) => number,
  future: Milestone[],
  currentTotals: EsopTotals,
): EsopUnblockForecast[] {
  if (future.length === 0) return [];

  const forecasts: EsopUnblockForecast[] = [];
  const applied: Milestone[] = [];
  for (const milestone of future) {
    applied.push(milestone);
    const cumulativeOf = (grant: EsopGrant): number =>
      applied.reduce((sum, m) => sum + m.amountOf(grant), 0);
    const forecastAmountOf = (grant: EsopGrant): number => heldAmountOf(grant) + cumulativeOf(grant);

    const date = parseIsoDate(milestone.date);
    if (!date) {
      throw new Error(`Invalid ESOP forecast date: ${milestone.date}`);
    }
    const forecastWarnings: string[] = [];
    const computed = grants.map((grant) =>
      valueGrant(grant, forecastAmountOf(grant), { ...assumptions, asOf: milestone.date }, date, forecastWarnings),
    );
    const totals = computeTotals(computed);
    const unlockedAmount = grants.reduce((sum, grant) => sum + cumulativeOf(grant), 0);
    const totalAmount = grants.reduce((sum, grant) => sum + forecastAmountOf(grant), 0);

    forecasts.push({
      id: milestone.id,
      label: milestone.forecastLabel,
      asOf: milestone.date,
      unlockedAmount,
      totalAmount,
      sumNis: totals.grossNis,
      netNis: totals.netNis,
      sumDeltaNis: totals.grossNis - currentTotals.grossNis,
      netDeltaNis: totals.netNis - currentTotals.netNis,
    });
  }
  return forecasts;
}

function sumUnblockAmounts(
  grants: EsopGrant[],
  key: 'unblockMay31Amount' | 'unblockAug31Amount',
): number {
  return grants.reduce((sum, grant) => sum + (grant[key] ?? 0), 0);
}

function sumMilestone(grants: EsopGrant[], milestone: Milestone): number {
  return grants.reduce((sum, grant) => sum + milestone.amountOf(grant), 0);
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
