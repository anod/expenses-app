import { describe, it, expect } from 'vitest';
import { paymentProgress } from './paymentProgress.js';
import type { RecurringTemplate } from './types.js';

const monthly = (
  startDate: string,
  endDate: string | undefined,
  day: number,
  skips?: string[],
): Pick<RecurringTemplate, 'startDate' | 'endDate' | 'cadence' | 'skips'> => ({
  startDate,
  ...(endDate ? { endDate } : {}),
  cadence: { kind: 'monthly', day, monthEndPolicy: 'clamp' },
  ...(skips ? { skips } : {}),
});

const weekly = (
  startDate: string,
  endDate: string | undefined,
  dayOfWeek: 0 | 1 | 2 | 3 | 4 | 5 | 6,
  skips?: string[],
): Pick<RecurringTemplate, 'startDate' | 'endDate' | 'cadence' | 'skips'> => ({
  startDate,
  ...(endDate ? { endDate } : {}),
  cadence: { kind: 'weekly', dayOfWeek },
  ...(skips ? { skips } : {}),
});

const monthlyPrediction = (
  startDate: string,
  endDate: string | undefined,
  skips?: string[],
): Pick<RecurringTemplate, 'startDate' | 'endDate' | 'cadence' | 'skips'> => ({
  startDate,
  ...(endDate ? { endDate } : {}),
  cadence: { kind: 'monthly_prediction' },
  ...(skips ? { skips } : {}),
});

describe('paymentProgress (monthly)', () => {
  it('returns null when there is no end date', () => {
    expect(paymentProgress(monthly('2024-01-01', undefined, 1), '2024-06-15')).toBeNull();
  });

  it('counts a simple full-year monthly schedule', () => {
    expect(paymentProgress(monthly('2024-01-15', '2024-12-15', 15), '2025-01-01'))
      .toEqual({ total: 12, paid: 12 });
  });

  it('caps paid at total when asOf is past the end', () => {
    expect(paymentProgress(monthly('2024-01-01', '2024-03-01', 1), '2099-01-01'))
      .toEqual({ total: 3, paid: 3 });
  });

  it('counts paid as 0 when today is before start', () => {
    expect(paymentProgress(monthly('2030-01-01', '2030-12-01', 1), '2024-01-01'))
      .toEqual({ total: 12, paid: 0 });
  });

  it('reports partial progress mid-stream', () => {
    expect(paymentProgress(monthly('2024-01-15', '2024-12-15', 15), '2024-05-20'))
      .toEqual({ total: 12, paid: 5 });
  });

  it('handles day=31 with clamping (Feb has 29 in 2024)', () => {
    expect(paymentProgress(monthly('2024-01-31', '2024-04-30', 31), '2024-04-30'))
      .toEqual({ total: 4, paid: 4 });
  });

  it('first occurrence is in the start month when day comes after start', () => {
    expect(paymentProgress(monthly('2024-01-05', '2024-03-10', 10), '2024-02-15'))
      .toEqual({ total: 3, paid: 2 });
  });

  it('first occurrence skips to next month when day comes before start', () => {
    expect(paymentProgress(monthly('2024-01-20', '2024-04-05', 5), '2024-04-05'))
      .toEqual({ total: 3, paid: 3 });
  });

  it('zero occurrences when no scheduled day falls within range', () => {
    expect(paymentProgress(monthly('2024-01-05', '2024-01-31', 1), '2024-12-01'))
      .toEqual({ total: 0, paid: 0 });
  });

  it('returns zeros when end is before start', () => {
    expect(paymentProgress(monthly('2024-06-01', '2024-01-01', 1), '2024-06-01'))
      .toEqual({ total: 0, paid: 0 });
  });
});

describe('paymentProgress (weekly)', () => {
  // 2024-01-05 is a Friday; 5 Fridays in Jan: 5, 12, 19, 26; Feb 2; …
  it('counts every Friday in a range with start on Friday', () => {
    // Jan 5 (Fri) → Jan 26 (Fri): 4 Fridays.
    expect(paymentProgress(weekly('2024-01-05', '2024-01-26', 5), '2024-01-26'))
      .toEqual({ total: 4, paid: 4 });
  });

  it('start on a non-matching weekday advances to the next match', () => {
    // Jan 1 2024 is Monday; first Friday is Jan 5.
    // Range Jan 1 → Jan 12: Fridays = Jan 5, Jan 12 → 2 total.
    expect(paymentProgress(weekly('2024-01-01', '2024-01-12', 5), '2024-01-08'))
      .toEqual({ total: 2, paid: 1 });
  });

  it('returns null for open-ended weekly', () => {
    expect(paymentProgress(weekly('2024-01-05', undefined, 5), '2024-06-01')).toBeNull();
  });

  it('skips shrink BOTH total and paid', () => {
    // Jan 5..Feb 2 = 5 Fridays. Skip Jan 12 and Jan 26 → total=3.
    // asOf=Jan 19 → before skip Jan 26 counts; non-skipped paid = Jan 5, Jan 19 = 2.
    expect(
      paymentProgress(
        weekly('2024-01-05', '2024-02-02', 5, ['2024-01-12', '2024-01-26']),
        '2024-01-19',
      ),
    ).toEqual({ total: 3, paid: 2 });
  });

  it('skip dates that are not actual occurrences are ignored', () => {
    // Skipping a Wednesday on a Friday template has no effect.
    expect(
      paymentProgress(
        weekly('2024-01-05', '2024-01-26', 5, ['2024-01-10']),
        '2024-01-26',
      ),
    ).toEqual({ total: 4, paid: 4 });
  });
});

describe('paymentProgress (monthly prediction)', () => {
  it('counts one occurrence per month on the anchor day', () => {
    expect(paymentProgress(monthlyPrediction('2024-01-01', '2024-03-31'), '2024-02-20'))
      .toEqual({ total: 3, paid: 2 });
  });

  it('moves the first paid month when startDate is after the anchor day', () => {
    expect(paymentProgress(monthlyPrediction('2024-01-20', '2024-04-30'), '2024-04-10'))
      .toEqual({ total: 3, paid: 3 });
  });

  it('skips shrink both total and paid', () => {
    expect(
      paymentProgress(
        monthlyPrediction('2024-01-01', '2024-03-31', ['2024-02-10']),
        '2024-03-20',
      ),
    ).toEqual({ total: 2, paid: 2 });
  });
});
