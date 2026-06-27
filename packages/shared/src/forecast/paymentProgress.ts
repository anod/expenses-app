import {
  addDays,
  addMonths,
  compareIso,
  firstBillingDayOnOrAfter,
  monthlyPredictionDate,
  weekdayOfIso,
} from './dates.js';
import type { IsoDate, RecurringTemplate } from './types.js';

type ScheduledTemplate = Pick<RecurringTemplate, 'startDate' | 'cadence'>;

const firstScheduledOccurrence = (template: ScheduledTemplate): IsoDate => {
  const { startDate: start, cadence } = template;
  if (cadence.kind === 'monthly') {
    return firstBillingDayOnOrAfter(start, cadence.day);
  }
  if (cadence.kind === 'monthly_prediction') {
    let cursor = monthlyPredictionDate(start);
    if (compareIso(cursor, start) < 0) cursor = monthlyPredictionDate(addMonths(start, 1));
    return cursor;
  }
  const diff = (cadence.dayOfWeek - weekdayOfIso(start) + 7) % 7;
  return diff === 0 ? start : addDays(start, diff);
};

const nextScheduledOccurrence = (
  cadence: RecurringTemplate['cadence'],
  current: IsoDate,
): IsoDate => {
  if (cadence.kind === 'monthly') {
    return firstBillingDayOnOrAfter(addDays(current, 1), cadence.day);
  }
  if (cadence.kind === 'monthly_prediction') {
    return monthlyPredictionDate(addMonths(current, 1));
  }
  return addDays(current, 7);
};

/**
 * Compute the inclusive end date for a fixed number of scheduled payments.
 * Payment 1 is the first actual occurrence on or after `startDate`.
 */
export const endDateForPaymentCount = (
  template: ScheduledTemplate,
  paymentCount: number,
): IsoDate => {
  if (!Number.isInteger(paymentCount) || paymentCount < 1) {
    throw new Error(`paymentCount must be >= 1 (got ${paymentCount})`);
  }
  let cursor = firstScheduledOccurrence(template);
  for (let i = 1; i < paymentCount; i++) {
    cursor = nextScheduledOccurrence(template.cadence, cursor);
  }
  return cursor;
};

/**
 * Count scheduled occurrences between startDate and endDate, ignoring skips.
 * Returns null for open-ended templates.
 */
export const scheduledPaymentCount = (
  template: Pick<RecurringTemplate, 'startDate' | 'endDate' | 'cadence'>,
): number | null => {
  if (!template.endDate) return null;
  if (compareIso(template.endDate, template.startDate) < 0) return 0;
  let total = 0;
  let cursor = firstScheduledOccurrence(template);
  for (let i = 0; i < 12_000 && compareIso(cursor, template.endDate) <= 0; i++) {
    total++;
    cursor = nextScheduledOccurrence(template.cadence, cursor);
  }
  return total;
};

/** Round a signed amount to whole cents (2 decimals). */
const roundCents = (value: number): number => Math.round(value * 100) / 100;

/**
 * Standard per-payment amount of an installment: the full (signed) price
 * divided across `count` payments, rounded to cents. Every payment uses this
 * value except the final one (see {@link installmentFinalPayment}).
 */
export const installmentPerPayment = (fullPrice: number, count: number): number => {
  if (!Number.isInteger(count) || count < 1) {
    throw new Error(`installment count must be >= 1 (got ${count})`);
  }
  return roundCents(fullPrice / count);
};

/**
 * Final per-payment amount of an installment. It absorbs the rounding
 * remainder so that `(count - 1) * perPayment + finalPayment === fullPrice`
 * exactly (to cent precision).
 */
export const installmentFinalPayment = (fullPrice: number, count: number): number => {
  const per = installmentPerPayment(fullPrice, count);
  return roundCents(fullPrice - per * (count - 1));
};

export interface PaymentProgress {
  /** Total non-skipped scheduled occurrences from start through end, inclusive. */
  total: number;
  /**
   * Non-skipped occurrences whose due date is on or before `asOf`
   * (capped at `total`).
   */
  paid: number;
}

/**
 * Count the occurrences of a fixed-term recurring template between its
 * `startDate` and `endDate` (both inclusive), and how many of those fall
 * on or before `asOf`.
 *
 * - Monthly: day-of-month is clamped against short months — matching the
 *   recurring-pipeline convention (e.g. `day: 31` resolves to the last
 *   day of February).
 * - Weekly: enumerates every `dayOfWeek` from the first matching weekday
 *   on or after `startDate`.
 *
 * Skipped dates listed in `template.skips` are excluded from BOTH
 * `total` and `paid`, so the denominator shrinks as the user marks
 * occurrences as cancelled (otherwise the user could never reach total).
 *
 * Returns `null` when the template is open-ended (no `endDate`) — the
 * caller decides how to render that (typically: no badge).
 *
 * Returns `{ total: 0, paid: 0 }` if the first scheduled occurrence on
 * or after `startDate` falls strictly after `endDate`.
 */
export const paymentProgress = (
  template: Pick<RecurringTemplate, 'startDate' | 'endDate' | 'cadence' | 'skips'>,
  asOf: IsoDate,
): PaymentProgress | null => {
  const { startDate: start, endDate: end, cadence, skips } = template;
  if (!end) return null;
  if (compareIso(end, start) < 0) return { total: 0, paid: 0 };
  const skipSet = new Set(skips ?? []);
  let cursor = firstScheduledOccurrence(template);

  let total = 0;
  let paid = 0;
  // Safety bound: ~1000 monthly years or ~230 weekly years.
  for (let i = 0; i < 12_000 && compareIso(cursor, end) <= 0; i++) {
    if (!skipSet.has(cursor)) {
      total++;
      if (compareIso(cursor, asOf) <= 0) paid++;
    }
    cursor = nextScheduledOccurrence(cadence, cursor);
  }
  return { total, paid };
};
