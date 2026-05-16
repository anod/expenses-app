import type { IsoDate } from './types.js';

const ISO_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

export const parseIso = (d: IsoDate): { y: number; m: number; d: number } => {
  const match = ISO_RE.exec(d);
  if (!match) throw new Error(`invalid ISO date: ${d}`);
  return { y: Number(match[1]), m: Number(match[2]), d: Number(match[3]) };
};

const pad2 = (n: number): string => (n < 10 ? `0${n}` : String(n));

export const formatIso = (y: number, m: number, d: number): IsoDate =>
  `${y}-${pad2(m)}-${pad2(d)}`;

export const daysInMonth = (year: number, month1: number): number => {
  // month1 is 1-12; use UTC Date with day 0 of next month
  return new Date(Date.UTC(year, month1, 0)).getUTCDate();
};

/** Clamp a desired day-of-month against the month's actual length. */
export const clampDayInMonth = (year: number, month1: number, day: number): number => {
  if (!Number.isInteger(day) || day < 1 || day > 31) {
    throw new Error(`invalid day: ${day}`);
  }
  const max = daysInMonth(year, month1);
  return Math.min(day, max);
};

/** Add `n` calendar months to a date, clamping the day if needed. */
export const addMonths = (date: IsoDate, n: number): IsoDate => {
  const { y, m, d } = parseIso(date);
  // Convert to zero-based then back.
  const total = (y * 12 + (m - 1)) + n;
  const ny = Math.floor(total / 12);
  const nm = (total % 12) + 1;
  const nd = clampDayInMonth(ny, nm, d);
  return formatIso(ny, nm, nd);
};

/** Add `n` days to a date. */
export const addDays = (date: IsoDate, n: number): IsoDate => {
  const { y, m, d } = parseIso(date);
  const dt = new Date(Date.UTC(y, m - 1, d + n));
  return formatIso(dt.getUTCFullYear(), dt.getUTCMonth() + 1, dt.getUTCDate());
};

export const compareIso = (a: IsoDate, b: IsoDate): number =>
  a < b ? -1 : a > b ? 1 : 0;

/**
 * The first date on or after `from` whose day-of-month equals `day`,
 * with clamping when the target month is short.
 */
export const firstBillingDayOnOrAfter = (from: IsoDate, day: number): IsoDate => {
  const { y, m } = parseIso(from);
  const candidate = formatIso(y, m, clampDayInMonth(y, m, day));
  if (compareIso(candidate, from) >= 0) return candidate;
  return firstBillingDayOnOrAfter(addMonths(formatIso(y, m, 1), 1), day);
};

/**
 * The first date strictly after `from` whose day-of-month equals `day`,
 * with clamping. Used for CC bill date from a charge date.
 */
export const firstBillingDayStrictlyAfter = (from: IsoDate, day: number): IsoDate => {
  const { y, m } = parseIso(from);
  const candidate = formatIso(y, m, clampDayInMonth(y, m, day));
  if (compareIso(candidate, from) > 0) return candidate;
  return firstBillingDayStrictlyAfter(addMonths(formatIso(y, m, 1), 1), day);
};

/** "Today" as an ISO date in the given IANA timezone. */
export const todayInZone = (timezone: string, now: Date = new Date()): IsoDate => {
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
  return fmt.format(now); // en-CA emits YYYY-MM-DD
};
