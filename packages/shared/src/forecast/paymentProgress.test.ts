import { describe, it, expect } from 'vitest';
import { paymentProgress } from './paymentProgress.js';

describe('paymentProgress', () => {
  it('returns null when there is no end date', () => {
    expect(paymentProgress('2024-01-01', null, 1, '2024-06-15')).toBeNull();
    expect(paymentProgress('2024-01-01', undefined, 1, '2024-06-15')).toBeNull();
  });

  it('counts a simple full-year monthly schedule', () => {
    const p = paymentProgress('2024-01-15', '2024-12-15', 15, '2025-01-01');
    expect(p).toEqual({ total: 12, paid: 12 });
  });

  it('caps paid at total when asOf is past the end', () => {
    const p = paymentProgress('2024-01-01', '2024-03-01', 1, '2099-01-01');
    expect(p).toEqual({ total: 3, paid: 3 });
  });

  it('counts paid as 0 when today is before start', () => {
    const p = paymentProgress('2030-01-01', '2030-12-01', 1, '2024-01-01');
    expect(p).toEqual({ total: 12, paid: 0 });
  });

  it('reports partial progress mid-stream', () => {
    // 12 monthly payments on the 15th; today is in May.
    const p = paymentProgress('2024-01-15', '2024-12-15', 15, '2024-05-20');
    expect(p).toEqual({ total: 12, paid: 5 });
  });

  it('handles day=31 with clamping (Feb has 29 in 2024)', () => {
    // Every "31st" from Jan 2024 through Apr 2024 inclusive.
    // Schedule: Jan 31, Feb 29 (clamped), Mar 31, Apr 30 (clamped).
    const p = paymentProgress('2024-01-31', '2024-04-30', 31, '2024-04-30');
    expect(p).toEqual({ total: 4, paid: 4 });
  });

  it('first occurrence is in the start month when day comes after start', () => {
    // Start Jan 5, day 10 → first occurrence is Jan 10 (same month).
    const p = paymentProgress('2024-01-05', '2024-03-10', 10, '2024-02-15');
    expect(p).toEqual({ total: 3, paid: 2 });
  });

  it('first occurrence skips to next month when day comes before start', () => {
    // Start Jan 20, day 5 → first occurrence is Feb 5.
    const p = paymentProgress('2024-01-20', '2024-04-05', 5, '2024-04-05');
    expect(p).toEqual({ total: 3, paid: 3 });
  });

  it('zero occurrences when no scheduled day falls within range', () => {
    // Start Jan 5, day 1, end Jan 31 → first occ would be Feb 1, after end.
    const p = paymentProgress('2024-01-05', '2024-01-31', 1, '2024-12-01');
    expect(p).toEqual({ total: 0, paid: 0 });
  });

  it('returns zeros when end is before start', () => {
    const p = paymentProgress('2024-06-01', '2024-01-01', 1, '2024-06-01');
    expect(p).toEqual({ total: 0, paid: 0 });
  });
});
