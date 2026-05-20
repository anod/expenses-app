import {
  addDays,
  addMonths,
  compareIso,
  firstBillingDayOnOrAfter,
  weekdayOfIso,
} from './dates.js';
import type { IsoDate, RecurringTemplate } from './types.js';

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
  let cursor: IsoDate;
  const advance: () => void = (() => {
    if (cadence.kind === 'monthly') {
      cursor = firstBillingDayOnOrAfter(start, cadence.day);
      return () => {
        cursor = addMonths(cursor, 1);
      };
    } else {
      // Step to the first matching weekday on or after `start`.
      const diff = (cadence.dayOfWeek - weekdayOfIso(start) + 7) % 7;
      cursor = diff === 0 ? start : addDays(start, diff);
      return () => {
        cursor = addDays(cursor, 7);
      };
    }
  })();

  let total = 0;
  let paid = 0;
  // Safety bound: ~1000 monthly years or ~230 weekly years.
  for (let i = 0; i < 12_000 && compareIso(cursor!, end) <= 0; i++) {
    if (!skipSet.has(cursor!)) {
      total++;
      if (compareIso(cursor!, asOf) <= 0) paid++;
    }
    advance();
  }
  return { total, paid };
};
