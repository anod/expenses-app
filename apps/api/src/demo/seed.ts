/**
 * Demo data builder — produces a deterministic-yet-funny snapshot of the
 * domain state so the app can be demoed without exposing real finances.
 *
 * The shape is built relative to a reference date (defaults to today) so the
 * demo always looks "fresh": recurring templates start in the past, ledger
 * entries are sprinkled across recent and upcoming days, and the cards have
 * outstanding debt due on the next billing day.
 *
 * All IDs are prefixed `demo:` so they can be told apart from real data and
 * (optionally) bulk-cleared by future tooling.
 */
import type {
  Account,
  CreditCard,
  LedgerEntry,
  RecurringTemplate,
  Settings,
} from '@expenses/shared';

export interface DemoState {
  account: Account;
  cards: CreditCard[];
  recurring: RecurringTemplate[];
  ledger: LedgerEntry[];
  settings: Settings;
}

const PREFIX = 'demo:';

const pad = (n: number): string => (n < 10 ? `0${n}` : String(n));

function isoDate(d: Date): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function shiftDays(base: Date, days: number): Date {
  const d = new Date(base);
  d.setDate(d.getDate() + days);
  return d;
}

function shiftMonths(base: Date, months: number): Date {
  const d = new Date(base);
  d.setMonth(d.getMonth() + months);
  return d;
}

export interface BuildDemoOptions {
  /** Anchor for "today". Defaults to current date. */
  today?: Date;
}

/**
 * Build the demo state. Pure function — no I/O, no Math.random; safe to call
 * from tests with a fixed `today` and get byte-identical output.
 */
export function buildDemoState(opts: BuildDemoOptions = {}): DemoState {
  const today = opts.today ?? new Date();
  const todayIso = isoDate(today);

  const calId = `${PREFIX}card:doom`;
  const visaId = `${PREFIX}card:plastic`;

  const account: Account = {
    bankBalance: 18_432.5,
    asOf: todayIso,
  };

  const cards: CreditCard[] = [
    {
      id: calId,
      name: 'Card of Doom',
      currentDebit: 3_217.4,
      asOf: todayIso,
      billingDayOfMonth: 2,
    },
    {
      id: visaId,
      name: 'Plastic Regret',
      currentDebit: 1_842.1,
      asOf: todayIso,
      billingDayOfMonth: 15,
    },
  ];

  const settings: Settings = {
    threshold: 2_000,
    timezone: 'Asia/Jerusalem',
    horizonMonths: 6,
    currency: 'ILS',
  };

  const recurringStart = isoDate(shiftMonths(today, -6));
  const recurring: RecurringTemplate[] = [
    {
      id: `${PREFIX}r:salary`,
      description: 'Salary from the Joke Factory',
      amount: 14_500,
      channel: 'bank',
      day: 1,
      startDate: recurringStart,
      monthEndPolicy: 'clamp',
    },
    {
      id: `${PREFIX}r:rent`,
      description: 'Rent for the Closet I Call Home',
      amount: -4_800,
      channel: 'bank',
      day: 5,
      startDate: recurringStart,
      monthEndPolicy: 'clamp',
    },
    {
      id: `${PREFIX}r:internet`,
      description: 'Suspiciously Cheap Internet',
      amount: -89,
      channel: 'bank',
      day: 10,
      startDate: recurringStart,
      monthEndPolicy: 'clamp',
    },
    {
      id: `${PREFIX}r:gym`,
      description: 'Gym Membership (cancelled but still paying)',
      amount: -149,
      channel: 'bank',
      day: 12,
      startDate: recurringStart,
      monthEndPolicy: 'clamp',
    },
    {
      id: `${PREFIX}r:streaming`,
      description: 'Netflix and Procrastinate',
      amount: -54.9,
      channel: 'bank',
      day: 18,
      startDate: recurringStart,
      monthEndPolicy: 'clamp',
    },
    {
      id: `${PREFIX}r:spotify`,
      description: 'Existential Spotify',
      amount: -19.9,
      channel: 'bank',
      day: 20,
      startDate: recurringStart,
      monthEndPolicy: 'clamp',
    },
    {
      id: `${PREFIX}r:cat`,
      description: 'Bribes for the Cat (non-negotiable)',
      amount: -120,
      channel: 'bank',
      day: 22,
      startDate: recurringStart,
      monthEndPolicy: 'clamp',
    },
    {
      id: `${PREFIX}r:therapy`,
      description: 'Therapy (required by therapist)',
      amount: -320,
      channel: 'bank',
      day: 25,
      startDate: recurringStart,
      monthEndPolicy: 'clamp',
    },
    {
      id: `${PREFIX}r:coffee`,
      description: 'Coffee Subscription Nobody Asked For',
      amount: -69,
      channel: `cc:${visaId}`,
      day: 8,
      startDate: recurringStart,
      monthEndPolicy: 'clamp',
    },
  ];

  const ledger: LedgerEntry[] = [
    {
      id: `${PREFIX}l:shawarma`,
      description: 'Emergency Shawarma',
      amount: -52,
      channel: 'bank',
      date: isoDate(shiftDays(today, -3)),
      status: 'cleared',
    },
    {
      id: `${PREFIX}l:plant`,
      description: 'Bought a plant I will definitely keep alive',
      amount: -89,
      channel: 'bank',
      date: isoDate(shiftDays(today, -5)),
      status: 'cleared',
    },
    {
      id: `${PREFIX}l:refund`,
      description: 'Refund from past-me\u2019s bad decision',
      amount: 240,
      channel: 'bank',
      date: isoDate(shiftDays(today, -1)),
      status: 'cleared',
    },
    {
      id: `${PREFIX}l:atm`,
      description: 'ATM withdrawal: cash for vibes',
      amount: -500,
      channel: 'bank',
      date: isoDate(shiftDays(today, -7)),
      status: 'cleared',
    },
    {
      id: `${PREFIX}l:birthday`,
      description: 'Birthday gift for a person I might know',
      amount: -180,
      channel: 'bank',
      date: isoDate(shiftDays(today, 4)),
      status: 'pending',
    },
    {
      id: `${PREFIX}l:concert`,
      description: 'Concert tickets (regret incoming)',
      amount: -480,
      channel: 'bank',
      date: isoDate(shiftDays(today, 9)),
      status: 'pending',
    },
    {
      id: `${PREFIX}l:dentist`,
      description: 'Dentist (the betrayal)',
      amount: -650,
      channel: 'bank',
      date: isoDate(shiftDays(today, 14)),
      status: 'pending',
    },
    {
      id: `${PREFIX}l:cc1`,
      description: 'Suspicious late-night AliExpress haul',
      amount: -342.8,
      channel: `cc:${calId}`,
      date: isoDate(shiftDays(today, -2)),
      status: 'cleared',
    },
    {
      id: `${PREFIX}l:cc2`,
      description: '\u201CJust one book\u201D (it was seven)',
      amount: -218,
      channel: `cc:${calId}`,
      date: isoDate(shiftDays(today, -4)),
      status: 'cleared',
    },
    {
      id: `${PREFIX}l:cc3`,
      description: 'Overpriced gadget I will never use',
      amount: -429,
      channel: `cc:${visaId}`,
      date: isoDate(shiftDays(today, -6)),
      status: 'cleared',
    },
    {
      id: `${PREFIX}l:cc4`,
      description: 'Snacks (it\u2019s called self-care)',
      amount: -78.5,
      channel: `cc:${visaId}`,
      date: isoDate(shiftDays(today, 2)),
      status: 'pending',
    },
  ];

  return { account, cards, recurring, ledger, settings };
}

export const DEMO_PREFIX = PREFIX;
