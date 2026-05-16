import {
  addDays,
  addMonths,
  clampDayInMonth,
  compareIso,
  firstBillingDayStrictlyAfter,
  formatIso,
  parseIso,
} from './dates.js';
import {
  type Account,
  type CreditCard,
  type DailyProjection,
  type ForecastResult,
  type ForecastStatus,
  type IsoDate,
  type LedgerEntry,
  type ProjectionCharge,
  type RecurringTemplate,
  type Settings,
  occurrenceKeyOf,
} from './types.js';

const validateNotFuture = (date: IsoDate, today: IsoDate, what: string): void => {
  if (compareIso(date, today) > 0) {
    throw new Error(`${what} asOf must not be in the future (got ${date}, today=${today})`);
  }
};

const assertBillingDay = (day: number, ctx: string): void => {
  if (!Number.isInteger(day) || day < 1 || day > 31) {
    throw new Error(`${ctx}: invalid day-of-month ${day}`);
  }
};

/** Generate all virtual recurring occurrences within [startDate, endDate]. */
export const generateVirtualOccurrences = (
  templates: ReadonlyArray<RecurringTemplate>,
  startDate: IsoDate,
  endDate: IsoDate,
): LedgerEntry[] => {
  const out: LedgerEntry[] = [];
  for (const t of templates) {
    assertBillingDay(t.day, `recurring ${t.id}`);
    const tplEnd = t.endDate ?? endDate;
    const effectiveEnd = compareIso(tplEnd, endDate) < 0 ? tplEnd : endDate;
    if (compareIso(t.startDate, effectiveEnd) > 0) continue;

    // Walk month by month from t.startDate's month forward.
    const { y, m } = parseIso(t.startDate);
    let cur = formatIso(y, m, clampDayInMonth(y, m, t.day));
    // Step backwards to the correct first occurrence if cur < startDate of template.
    if (compareIso(cur, t.startDate) < 0) cur = nextOccurrence(cur, t.day);

    while (compareIso(cur, effectiveEnd) <= 0) {
      if (compareIso(cur, startDate) >= 0) {
        out.push({
          id: `virtual:${t.id}:${cur}`,
          description: t.description,
          amount: t.amount,
          channel: t.channel,
          date: cur,
          status: 'pending',
          recurringId: t.id,
          occurrenceKey: occurrenceKeyOf(t.id, cur),
        });
      }
      cur = nextOccurrence(cur, t.day);
    }
  }
  return out;
};

const nextOccurrence = (current: IsoDate, day: number): IsoDate => {
  const next = addMonths(current, 1);
  const { y, m } = parseIso(next);
  return formatIso(y, m, clampDayInMonth(y, m, day));
};

/**
 * Merge persisted ledger entries with virtual recurring occurrences.
 * - Persisted entries with a matching `occurrenceKey` REPLACE virtuals.
 * - Standalone persisted entries (no recurringId) pass through.
 * - Only 'pending' status entries are kept.
 * - Per-channel `asOf` filter:
 *     bank channel:    date >= account.asOf
 *     cc:<cardId>:     date >  card.asOf  (strictly after)
 */
export const mergeWithOverrides = (
  virtuals: ReadonlyArray<LedgerEntry>,
  persisted: ReadonlyArray<LedgerEntry>,
  account: Account,
  cards: ReadonlyArray<CreditCard>,
): LedgerEntry[] => {
  // Invariant guard: recurringId IS NULL ⇔ occurrenceKey IS NULL
  for (const e of persisted) {
    if ((e.recurringId == null) !== (e.occurrenceKey == null)) {
      throw new Error(
        `ledger entry ${e.id}: recurringId and occurrenceKey must be both set or both null`,
      );
    }
  }

  const overrideKeys = new Set<string>();
  for (const e of persisted) {
    if (e.occurrenceKey != null) overrideKeys.add(e.occurrenceKey);
  }

  const cardById = new Map<string, CreditCard>();
  for (const c of cards) cardById.set(c.id, c);

  const keep = (e: LedgerEntry): boolean => {
    if (e.status !== 'pending') return false;
    if (e.channel === 'bank') return compareIso(e.date, account.asOf) >= 0;
    const cardId = e.channel.slice(3);
    const card = cardById.get(cardId);
    if (!card) {
      throw new Error(`ledger entry ${e.id}: unknown card ${cardId}`);
    }
    return compareIso(e.date, card.asOf) > 0;
  };

  const merged: LedgerEntry[] = [];
  for (const v of virtuals) {
    if (v.occurrenceKey && overrideKeys.has(v.occurrenceKey)) continue;
    if (keep(v)) merged.push(v);
  }
  for (const p of persisted) {
    if (keep(p)) merged.push(p);
  }
  return merged;
};

/**
 * Project a daily balance series from startDate to endDate (inclusive).
 * - bank entries hit the bank on their date.
 * - cc entries are aggregated per card per billing day into one synthetic
 *   "Credit card bill" charge.
 * - Each card's `currentDebit` becomes a bank debit on
 *   `firstBillingDayStrictlyAfter(card.asOf, billingDay)`.
 */
export const project = (
  effective: ReadonlyArray<LedgerEntry>,
  account: Account,
  cards: ReadonlyArray<CreditCard>,
  settings: Settings,
  today: IsoDate,
): ForecastResult => {
  validateNotFuture(account.asOf, today, 'account');
  for (const c of cards) {
    validateNotFuture(c.asOf, today, `card ${c.id}`);
    assertBillingDay(c.billingDayOfMonth, `card ${c.id}`);
  }

  const startDate = compareIso(account.asOf, today) > 0 ? account.asOf : today;
  const endDate = addMonths(startDate, settings.horizonMonths);

  // Bucket charges by date.
  const bankByDate = new Map<IsoDate, ProjectionCharge[]>();
  const ccByCardBillDate = new Map<string, Map<IsoDate, LedgerEntry[]>>();

  const pushBank = (date: IsoDate, charge: ProjectionCharge): void => {
    let arr = bankByDate.get(date);
    if (!arr) {
      arr = [];
      bankByDate.set(date, arr);
    }
    arr.push(charge);
  };

  const pushCc = (cardId: string, billDate: IsoDate, entry: LedgerEntry): void => {
    let m = ccByCardBillDate.get(cardId);
    if (!m) {
      m = new Map();
      ccByCardBillDate.set(cardId, m);
    }
    let arr = m.get(billDate);
    if (!arr) {
      arr = [];
      m.set(billDate, arr);
    }
    arr.push(entry);
  };

  const cardById = new Map<string, CreditCard>();
  for (const c of cards) cardById.set(c.id, c);

  for (const e of effective) {
    if (e.status !== 'pending') continue;
    if (compareIso(e.date, endDate) > 0) continue;
    if (e.channel === 'bank') {
      if (compareIso(e.date, startDate) < 0) continue;
      pushBank(e.date, {
        description: e.description,
        amount: e.amount,
        source: { kind: 'ledger', entryId: e.id },
      });
    } else {
      const cardId = e.channel.slice(3);
      const card = cardById.get(cardId);
      if (!card) throw new Error(`unknown card ${cardId} on entry ${e.id}`);
      const billDate = firstBillingDayStrictlyAfter(e.date, card.billingDayOfMonth);
      if (compareIso(billDate, startDate) < 0) continue;
      if (compareIso(billDate, endDate) > 0) continue;
      pushCc(cardId, billDate, e);
    }
  }

  // Roll up current debit of each card → bank debit on next strictly-after billing day.
  for (const card of cards) {
    if (card.currentDebit === 0) continue;
    const billDate = firstBillingDayStrictlyAfter(card.asOf, card.billingDayOfMonth);
    if (compareIso(billDate, startDate) < 0) continue;
    if (compareIso(billDate, endDate) > 0) continue;
    pushBank(billDate, {
      description: `Credit card opening balance (${card.name})`,
      amount: -card.currentDebit,
      source: { kind: 'cc-bill', cardId: card.id, billedEntries: [] },
    });
  }

  // Flatten cc-by-card → synthetic bank entries.
  for (const [cardId, perDate] of ccByCardBillDate.entries()) {
    const card = cardById.get(cardId);
    if (!card) continue;
    for (const [billDate, entries] of perDate.entries()) {
      const total = entries.reduce((s, e) => s + e.amount, 0);
      pushBank(billDate, {
        description: `Credit card bill (${card.name}, ${entries.length} charge${entries.length === 1 ? '' : 's'})`,
        amount: total,
        source: { kind: 'cc-bill', cardId, billedEntries: entries.slice() },
      });
    }
  }

  // Walk days.
  const days: DailyProjection[] = [];
  let balance = account.bankBalance;
  let cur = startDate;
  while (compareIso(cur, endDate) <= 0) {
    const charges = bankByDate.get(cur) ?? [];
    const delta = charges.reduce((s, c) => s + c.amount, 0);
    balance += delta;
    const { d } = parseIso(cur);
    days.push({
      date: cur,
      balance,
      delta,
      charges,
      isAnchor: d === 10,
    });
    cur = addDays(cur, 1);
  }

  // Status from min balance.
  let minBalance = Number.POSITIVE_INFINITY;
  let minBalanceDate = startDate;
  for (const day of days) {
    if (day.balance < minBalance) {
      minBalance = day.balance;
      minBalanceDate = day.date;
    }
  }
  const status: ForecastStatus =
    minBalance < settings.threshold
      ? 'breach'
      : minBalance < settings.threshold * 1.2
        ? 'warning'
        : 'safe';

  return { startDate, endDate, days, status, minBalance, minBalanceDate };
};

/** End-to-end convenience: virtuals → merge → project. */
export const forecast = (input: {
  templates: ReadonlyArray<RecurringTemplate>;
  persisted: ReadonlyArray<LedgerEntry>;
  account: Account;
  cards: ReadonlyArray<CreditCard>;
  settings: Settings;
  today: IsoDate;
}): ForecastResult => {
  const startDate = compareIso(input.account.asOf, input.today) > 0
    ? input.account.asOf
    : input.today;
  const endDate = addMonths(startDate, input.settings.horizonMonths);
  const virtuals = generateVirtualOccurrences(input.templates, startDate, endDate);
  const effective = mergeWithOverrides(virtuals, input.persisted, input.account, input.cards);
  return project(effective, input.account, input.cards, input.settings, input.today);
};
