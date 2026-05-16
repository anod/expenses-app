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
  type CardForecast,
  type CardDailyBalance,
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
/**
 * Strip overrides + filter to "pending after asOf" entries.
 *
 * - account.bankBalance is the balance at the END of account.asOf, so bank
 *   entries dated ≤ asOf are dropped (already reflected in the balance).
 *     bank:           date >  account.asOf  (strictly after)
 * - card.currentDebit is the outstanding at END of card.asOf, so cc entries
 *   dated ≤ asOf are dropped (already reflected in currentDebit).
 *     cc:<cardId>:    date >  card.asOf     (strictly after)
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
    if (e.channel === 'bank') return compareIso(e.date, account.asOf) > 0;
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

  const visibleStart = compareIso(account.asOf, today) > 0 ? account.asOf : today;
  const walkStart = account.asOf;
  const endDate = addMonths(visibleStart, settings.horizonMonths);

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
      if (compareIso(e.date, walkStart) <= 0) continue;
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
      if (compareIso(billDate, walkStart) < 0) continue;
      if (compareIso(billDate, endDate) > 0) continue;
      pushCc(cardId, billDate, e);
    }
  }

  // Roll up current debit of each card → bank debit on next strictly-after billing day.
  for (const card of cards) {
    if (card.currentDebit === 0) continue;
    const billDate = firstBillingDayStrictlyAfter(card.asOf, card.billingDayOfMonth);
    if (compareIso(billDate, walkStart) < 0) continue;
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

  // Walk from walkStart (the asOf date) so charges between asOf and today are
  // applied to the bank balance, but only emit days from visibleStart onward
  // (we don't show historical days in the UI; they've already happened).
  const days: DailyProjection[] = [];
  let balance = account.bankBalance;
  let cur = walkStart;
  while (compareIso(cur, endDate) <= 0) {
    const charges = bankByDate.get(cur) ?? [];
    const delta = charges.reduce((s, c) => s + c.amount, 0);
    balance += delta;
    if (compareIso(cur, visibleStart) >= 0) {
      const { d } = parseIso(cur);
      days.push({
        date: cur,
        balance,
        delta,
        charges,
        isAnchor: d === 10,
      });
    }
    cur = addDays(cur, 1);
  }

  // Status from min balance.
  let minBalance = Number.POSITIVE_INFINITY;
  let minBalanceDate = visibleStart;
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

  // Per-card outstanding tracking. Outstanding rises on cc-charge date and
  // is reset to 0 on the billing day (after the bill is paid). Bills include
  // both the opening currentDebit (first billing day strictly after asOf) and
  // any cc-charges accumulated since the previous bill.
  const ccChargesByCardDate = new Map<string, Map<IsoDate, number>>();
  for (const e of effective) {
    if (e.status !== 'pending') continue;
    if (e.channel === 'bank') continue;
    const cardId = e.channel.slice(3);
    let m = ccChargesByCardDate.get(cardId);
    if (!m) {
      m = new Map();
      ccChargesByCardDate.set(cardId, m);
    }
    const prev = m.get(e.date) ?? 0;
    m.set(e.date, prev + Math.abs(e.amount));
  }

  const cardForecasts: CardForecast[] = cards.map((card) => {
    const dayList: CardDailyBalance[] = [];
    let outstanding = card.currentDebit;

    const perDate = ccChargesByCardDate.get(card.id);
    let cur = walkStart;
    let openingDebitForResult = card.currentDebit;
    while (compareIso(cur, endDate) <= 0) {
      const accrued = perDate?.get(cur) ?? 0;
      outstanding += accrued;
      const { d } = parseIso(cur);
      const isBillingDay = d === card.billingDayOfMonth;
      // On the billing day, debt is settled at end of day.
      if (isBillingDay && compareIso(cur, card.asOf) > 0) {
        outstanding = 0;
      }
      if (compareIso(cur, visibleStart) >= 0) {
        // Capture the outstanding balance the first time we hit visibleStart;
        // that is the "opening debit" the UI shows as "current debit".
        if (dayList.length === 0) openingDebitForResult = outstanding;
        dayList.push({ date: cur, outstanding, isBillingDay });
      }
      cur = addDays(cur, 1);
    }

    return {
      cardId: card.id,
      name: card.name,
      billingDayOfMonth: card.billingDayOfMonth,
      asOf: card.asOf,
      openingDebit: openingDebitForResult,
      days: dayList,
    };
  });

  return {
    startDate: visibleStart, endDate, days, status, minBalance, minBalanceDate,
    cards: cardForecasts,
    account: { asOf: account.asOf, bankBalance: account.bankBalance },
  };
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
  // Walk from asOf (so charges between asOf and today affect today's balance)
  // but compute horizon endDate from the visible window start.
  const visibleStart = compareIso(input.account.asOf, input.today) > 0
    ? input.account.asOf
    : input.today;
  const endDate = addMonths(visibleStart, input.settings.horizonMonths);
  const virtuals = generateVirtualOccurrences(input.templates, input.account.asOf, endDate);
  const effective = mergeWithOverrides(virtuals, input.persisted, input.account, input.cards);
  return project(effective, input.account, input.cards, input.settings, input.today);
};
