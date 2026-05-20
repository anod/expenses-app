import {
  addMonths,
  compareIso,
  firstBillingDayOnOrAfter,
} from './dates.js';
import type { IsoDate } from './types.js';

export interface PaymentProgress {
  /** Total scheduled occurrences from start through end, inclusive. */
  total: number;
  /** Occurrences whose due date is on or before `asOf` (capped at `total`). */
  paid: number;
}

/**
 * Count the occurrences of a fixed-day monthly schedule between `start`
 * and `end` (both inclusive), and how many of those fall on or before
 * `asOf`. Day-of-month is clamped against short months — matching the
 * recurring-pipeline convention (e.g. `day: 31` resolves to the last
 * day of February).
 *
 * Returns `null` when there is no `end` (open-ended schedule), so the
 * caller can render "—" or similar without faking a denominator.
 *
 * Returns `{ total: 0, paid: 0 }` if the first scheduled occurrence on
 * or after `start` falls strictly after `end`.
 */
export const paymentProgress = (
  start: IsoDate,
  end: IsoDate | null | undefined,
  day: number,
  asOf: IsoDate,
): PaymentProgress | null => {
  if (!end) return null;
  if (compareIso(end, start) < 0) return { total: 0, paid: 0 };

  let cursor = firstBillingDayOnOrAfter(start, day);
  let total = 0;
  let paid = 0;
  // Safety bound: ~1000 years of monthly occurrences.
  for (let i = 0; i < 12_000 && compareIso(cursor, end) <= 0; i++) {
    total++;
    if (compareIso(cursor, asOf) <= 0) paid++;
    cursor = addMonths(cursor, 1);
  }
  return { total, paid };
};
