/**
 * Demo data builder — produces a deterministic, realistic snapshot of the
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

  const travelCardId = `${PREFIX}card:travel`;
  const householdCardId = `${PREFIX}card:household`;

  const account: Account = {
    bankBalance: 18_432.5,
    asOf: todayIso,
  };

  const cards: CreditCard[] = [
    {
      id: travelCardId,
      name: 'Travel Rewards Visa',
      currentDebit: 3_217.4,
      asOf: todayIso,
      billingDayOfMonth: 2,
    },
    {
      id: householdCardId,
      name: 'Household Mastercard',
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
      description: 'Monthly salary',
      amount: 14_500,
      channel: 'bank',
      cadence: { kind: 'monthly', day: 1, monthEndPolicy: 'clamp' },
      startDate: recurringStart,
    },
    {
      id: `${PREFIX}r:rent`,
      description: 'Apartment rent',
      amount: -4_800,
      channel: 'bank',
      cadence: { kind: 'monthly', day: 5, monthEndPolicy: 'clamp' },
      startDate: recurringStart,
    },
    {
      id: `${PREFIX}r:internet`,
      description: 'Home internet',
      amount: -89,
      channel: 'bank',
      cadence: { kind: 'monthly', day: 10, monthEndPolicy: 'clamp' },
      startDate: recurringStart,
    },
    {
      id: `${PREFIX}r:gym`,
      description: 'Gym membership',
      amount: -149,
      channel: 'bank',
      cadence: { kind: 'monthly', day: 12, monthEndPolicy: 'clamp' },
      startDate: recurringStart,
    },
    {
      id: `${PREFIX}r:streaming`,
      description: 'Streaming subscriptions',
      amount: -54.9,
      channel: 'bank',
      cadence: { kind: 'monthly', day: 18, monthEndPolicy: 'clamp' },
      startDate: recurringStart,
    },
    {
      id: `${PREFIX}r:music`,
      description: 'Music subscription',
      amount: -19.9,
      channel: 'bank',
      cadence: { kind: 'monthly', day: 20, monthEndPolicy: 'clamp' },
      startDate: recurringStart,
    },
    {
      id: `${PREFIX}r:utilities`,
      description: 'Electricity and water',
      amount: -120,
      channel: 'bank',
      cadence: { kind: 'monthly', day: 22, monthEndPolicy: 'clamp' },
      startDate: recurringStart,
    },
    {
      id: `${PREFIX}r:health`,
      description: 'Health insurance',
      amount: -320,
      channel: 'bank',
      cadence: { kind: 'monthly', day: 25, monthEndPolicy: 'clamp' },
      startDate: recurringStart,
    },
    {
      id: `${PREFIX}r:mobile`,
      description: 'Mobile phone plan',
      amount: -69,
      channel: `cc:${householdCardId}`,
      cadence: { kind: 'monthly', day: 8, monthEndPolicy: 'clamp' },
      startDate: recurringStart,
    },
    {
      id: `${PREFIX}r:supermarket`,
      description: 'Monthly groceries estimate',
      amount: -1600,
      channel: 'bank',
      cadence: { kind: 'monthly_prediction' },
      startDate: recurringStart,
    },
  ];

  const ledger: LedgerEntry[] = [
    {
      id: `${PREFIX}l:restaurant`,
      description: 'Restaurant dinner',
      amount: -52,
      channel: 'bank',
      date: isoDate(shiftDays(today, -3)),
      status: 'cleared',
    },
    {
      id: `${PREFIX}l:supplies`,
      description: 'Home supplies',
      amount: -89,
      channel: 'bank',
      date: isoDate(shiftDays(today, -5)),
      status: 'cleared',
    },
    {
      id: `${PREFIX}l:refund`,
      description: 'Returned item refund',
      amount: 240,
      channel: 'bank',
      date: isoDate(shiftDays(today, -1)),
      status: 'cleared',
    },
    {
      id: `${PREFIX}l:atm`,
      description: 'ATM withdrawal',
      amount: -500,
      channel: 'bank',
      date: isoDate(shiftDays(today, -7)),
      status: 'cleared',
    },
    {
      id: `${PREFIX}l:birthday`,
      description: 'Birthday gift',
      amount: -180,
      channel: 'bank',
      date: isoDate(shiftDays(today, 4)),
      status: 'pending',
    },
    {
      id: `${PREFIX}l:concert`,
      description: 'Event tickets',
      amount: -480,
      channel: 'bank',
      date: isoDate(shiftDays(today, 9)),
      status: 'pending',
    },
    {
      id: `${PREFIX}l:dentist`,
      description: 'Dental appointment',
      amount: -650,
      channel: 'bank',
      date: isoDate(shiftDays(today, 14)),
      status: 'pending',
    },
    {
      id: `${PREFIX}l:cc1`,
      description: 'Online shopping',
      amount: -342.8,
      channel: `cc:${travelCardId}`,
      date: isoDate(shiftDays(today, -2)),
      status: 'cleared',
    },
    {
      id: `${PREFIX}l:cc2`,
      description: 'Books and learning',
      amount: -218,
      channel: `cc:${travelCardId}`,
      date: isoDate(shiftDays(today, -4)),
      status: 'cleared',
    },
    {
      id: `${PREFIX}l:cc3`,
      description: 'Electronics accessory',
      amount: -429,
      channel: `cc:${householdCardId}`,
      date: isoDate(shiftDays(today, -6)),
      status: 'cleared',
    },
    {
      id: `${PREFIX}l:cc4`,
      description: 'Grocery top-up',
      amount: -78.5,
      channel: `cc:${householdCardId}`,
      date: isoDate(shiftDays(today, 2)),
      status: 'pending',
    },
  ];

  return { account, cards, recurring, ledger, settings };
}

export const DEMO_PREFIX = PREFIX;
