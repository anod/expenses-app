import {
  addDays,
  addMonths,
  firstBillingDayOnOrAfter,
  firstBillingDayStrictlyAfter,
} from './dates.js';
import type {
  DailyProjection,
  ForecastPeriod,
  IsoDate,
  SpendingBudget,
  SpendingBudgetForecast,
} from './types.js';

export const isSpendingBudgetAmount = (value: unknown): value is number =>
  typeof value === 'number' &&
  Number.isFinite(value) &&
  value >= 0 &&
  Number.isSafeInteger(Math.round(value * 100)) &&
  Math.abs(value * 100 - Math.round(value * 100)) < 1e-7;

const daysBetween = (from: IsoDate, to: IsoDate): number =>
  Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);

/** Allocate integer cents; the closing day absorbs the rounding remainder. */
export const spendingBudgetAllocations = (
  budget: SpendingBudget,
  from: IsoDate,
  through: IsoDate,
): { date: IsoDate; amount: number }[] => {
  if (!isSpendingBudgetAmount(budget.monthlyAllowance) || !isSpendingBudgetAmount(budget.remaining)) {
    throw new Error('spending budget amounts must be finite, nonnegative amounts in whole cents');
  }
  const snapshotEnd = firstBillingDayStrictlyAfter(budget.asOf, 10);
  const allocations: { date: IsoDate; amount: number }[] = [];
  const start = from > budget.asOf ? from : addDays(budget.asOf, 1);
  for (let date = start; date <= through; date = addDays(date, 1)) {
    const periodEnd = firstBillingDayOnOrAfter(date, 10);
    const periodStart = periodEnd === snapshotEnd
      ? addDays(budget.asOf, 1)
      : addDays(addMonths(periodEnd, -1), 1);
    const totalCents = Math.round(
      (periodEnd === snapshotEnd ? budget.remaining : budget.monthlyAllowance) * 100,
    );
    const dayCount = daysBetween(periodStart, periodEnd) + 1;
    const dailyCents = Math.floor(totalCents / dayCount);
    const cents = date === periodEnd
      ? totalCents - dailyCents * (dayCount - 1)
      : dailyCents;
    allocations.push({ date, amount: cents / 100 });
  }
  return allocations;
};

export const projectSpendingBudget = (
  budget: SpendingBudget,
  today: IsoDate,
): SpendingBudgetForecast => {
  const periodEnd = firstBillingDayStrictlyAfter(today, 10);
  const remainingCents = spendingBudgetAllocations(budget, addDays(today, 1), periodEnd)
    .reduce((sum, allocation) => sum + Math.round(allocation.amount * 100), 0);
  return { ...budget, remainingToday: remainingCents / 100, periodEnd };
};

/** Group expected cash outflows into forecast periods ending on the 10th. */
export const buildForecastPeriods = (days: readonly DailyProjection[]): ForecastPeriod[] => {
  const periods = new Map<IsoDate, ForecastPeriod>();
  for (const day of days) {
    const endDate = firstBillingDayOnOrAfter(day.date, 10);
    let period = periods.get(endDate);
    if (!period) {
      const startDate = addDays(addMonths(endDate, -1), 1);
      period = {
        startDate, endDate, coveredStart: day.date, coveredEnd: day.date,
        partial: day.date !== startDate,
        scheduledOutflows: 0, additionalAllowance: 0, totalOutflows: 0,
      };
      periods.set(endDate, period);
    }
    period.coveredEnd = day.date;
    for (const charge of day.charges) {
      if (charge.amount >= 0) continue;
      const field = charge.source.kind === 'spending-budget'
        ? 'additionalAllowance' : 'scheduledOutflows';
      period[field] = (Math.round(period[field] * 100) - Math.round(charge.amount * 100)) / 100;
    }
  }
  for (const period of periods.values()) {
    period.partial ||= period.coveredEnd !== period.endDate;
    period.totalOutflows = (
      Math.round(period.scheduledOutflows * 100) + Math.round(period.additionalAllowance * 100)
    ) / 100;
  }
  return [...periods.values()];
};
