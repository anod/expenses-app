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
 * A share-unlock milestone. `date` is the ISO date the shares vest on (read
 * from the workbook column header); `amountOf` returns the shares a given grant
 * unlocks on that date.
 */
interface Milestone {
  date: string;
  label: string;
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

  const milestones = buildMilestones(grants);
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

  // Totals over only the grants that have passed the lock-down edge (their
  // stock gain is taxed at the capital-gains rate), so the UI can show net
  // *excluding* still-locked grants (in red) next to the all-grants total.
  const pastLockdownTotals = computeTotals(
    computed.filter((row) => row.ageDays >= normalizedAssumptions.lockDownDays),
  );

  const pastUnlocks: EsopPastUnlock[] = passed.map((m) => ({
    date: m.date,
    label: m.label,
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
    pastLockdownTotals,
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

const UNLOCK_MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** Format an ISO unlock date as a compact human label, e.g. "May 31, 2026". */
export function esopUnlockLabel(isoDate: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(isoDate);
  if (!match) return isoDate;
  const [, year, month, day] = match;
  return `${UNLOCK_MONTHS[Number(month) - 1] ?? month} ${Number(day)}, ${year}`;
}

/**
 * One milestone per distinct unlock date across all grants, sorted ascending.
 * Dates come straight from the workbook column headers — no guessing.
 */
function buildMilestones(grants: EsopGrant[]): Milestone[] {
  const dates = new Set<string>();
  for (const grant of grants) {
    for (const unlock of grant.unlocks ?? []) {
      if (unlock.amount > 0 && /^\d{4}-\d{2}-\d{2}$/.test(unlock.date)) dates.add(unlock.date);
    }
  }
  return [...dates].sort().map((date) => ({
    date,
    label: esopUnlockLabel(date),
    amountOf: (grant: EsopGrant) => unlockAmountOn(grant, date),
  }));
}

function unlockAmountOn(grant: EsopGrant, date: string): number {
  return (grant.unlocks ?? [])
    .filter((unlock) => unlock.date === date)
    .reduce((sum, unlock) => sum + unlock.amount, 0);
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
      date: milestone.date,
      label: `After ${milestone.label}`,
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

function sumMilestone(grants: EsopGrant[], milestone: Milestone): number {
  return grants.reduce((sum, grant) => sum + milestone.amountOf(grant), 0);
}

function parseIsoDate(value: string): Date | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const date = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(date.getTime()) ? date : null;
}
