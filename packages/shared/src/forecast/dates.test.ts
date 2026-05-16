import { describe, expect, it } from 'vitest';
import {
  addDays,
  addMonths,
  clampDayInMonth,
  firstBillingDayOnOrAfter,
  firstBillingDayStrictlyAfter,
} from './dates.js';

describe('dates', () => {
  it('clampDayInMonth: 31 in Feb 2026 → 28', () => {
    expect(clampDayInMonth(2026, 2, 31)).toBe(28);
  });

  it('clampDayInMonth: 31 in Feb 2024 → 29 (leap)', () => {
    expect(clampDayInMonth(2024, 2, 31)).toBe(29);
  });

  it('addMonths: day clamp into Feb', () => {
    expect(addMonths('2026-01-31', 1)).toBe('2026-02-28');
  });

  it('addMonths: 6 months from 2026-05-16', () => {
    expect(addMonths('2026-05-16', 6)).toBe('2026-11-16');
  });

  it('addDays: positive', () => {
    expect(addDays('2026-05-30', 5)).toBe('2026-06-04');
  });

  it('firstBillingDayOnOrAfter: same day returns same date', () => {
    expect(firstBillingDayOnOrAfter('2026-06-02', 2)).toBe('2026-06-02');
  });

  it('firstBillingDayOnOrAfter: rolls forward', () => {
    expect(firstBillingDayOnOrAfter('2026-06-03', 2)).toBe('2026-07-02');
  });

  it('firstBillingDayStrictlyAfter: on billing day → next month', () => {
    expect(firstBillingDayStrictlyAfter('2026-06-02', 2)).toBe('2026-07-02');
  });

  it('firstBillingDayStrictlyAfter: one day before → same month', () => {
    expect(firstBillingDayStrictlyAfter('2026-06-01', 2)).toBe('2026-06-02');
  });

  it('firstBillingDayStrictlyAfter: clamps day 31 in Feb', () => {
    expect(firstBillingDayStrictlyAfter('2026-01-31', 31)).toBe('2026-02-28');
  });
});
