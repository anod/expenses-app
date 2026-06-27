import {
  addDays,
  addMonths,
  clampDayInMonth,
  compareIso,
  firstBillingDayOnOrAfter,
  firstBillingDayStrictlyAfter,
  formatIso,
  monthlyPredictionDate,
  parseIso,
  weekdayOfIso,
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

/** First date `>= from` whose weekday is `dayOfWeek` (0=Sun..6=Sat). */
const firstWeekdayOnOrAfter = (from: IsoDate, dayOfWeek: number): IsoDate => {
  const diff = (dayOfWeek - weekdayOfIso(from) + 7) % 7;
  return diff === 0 ? from : addDays(from, diff);
};

/**
 * Start of the current anchor period: the most recent anchor day (the 10th)
 * on or before `today`. Matches the pipeline's `isAnchor = d === 10` rule.
 */
const ANCHOR_DAY_OF_MONTH = 10;
const currentPeriodAnchorStart = (today: IsoDate): IsoDate => {
  const { y, m, d } = parseIso(today);
  if (d >= ANCHOR_DAY_OF_MONTH) return formatIso(y, m, ANCHOR_DAY_OF_MONTH);
  const prevMonth = addMonths(formatIso(y, m, 1), -1);
  const { y: py, m: pm } = parseIso(prevMonth);
  return formatIso(py, pm, ANCHOR_DAY_OF_MONTH);
};

/** Generate all virtual recurring occurrences within [startDate, endDate]. */
export const generateVirtualOccurrences = (
  templates: ReadonlyArray<RecurringTemplate>,
  startDate: IsoDate,
  endDate: IsoDate,
): LedgerEntry[] => {
  const out: LedgerEntry[] = [];
  for (const t of templates) {
    const tplEnd = t.endDate ?? endDate;
    const effectiveEnd = compareIso(tplEnd, endDate) < 0 ? tplEnd : endDate;
    if (compareIso(t.startDate, effectiveEnd) > 0) continue;

    const skipSet = new Set(t.skips ?? []);
    const emit = (date: IsoDate): void => {
      if (skipSet.has(date)) return;
      if (compareIso(date, startDate) < 0) return;
      out.push({
        id: `virtual:${t.id}:${date}`,
        description: t.description,
        amount: t.amount,
        channel: t.channel,
        date,
        status: 'pending',
        recurringId: t.id,
        occurrenceKey: occurrenceKeyOf(t.id, date),
      });
    };

    switch (t.cadence.kind) {
      case 'monthly': {
        assertBillingDay(t.cadence.day, `recurring ${t.id}`);
        const day = t.cadence.day;
        const { y, m } = parseIso(t.startDate);
        let cur = formatIso(y, m, clampDayInMonth(y, m, day));
        if (compareIso(cur, t.startDate) < 0) cur = nextMonthlyOccurrence(cur, day);
        while (compareIso(cur, effectiveEnd) <= 0) {
          emit(cur);
          cur = nextMonthlyOccurrence(cur, day);
        }
        break;
      }
      case 'monthly_prediction': {
        let cur = monthlyPredictionDate(t.startDate);
        if (compareIso(cur, t.startDate) < 0) cur = monthlyPredictionDate(addMonths(t.startDate, 1));
        while (compareIso(cur, effectiveEnd) <= 0) {
          emit(cur);
          cur = monthlyPredictionDate(addMonths(cur, 1));
        }
        break;
      }
      case 'weekly': {
        // Weekly: enumerate every 7 days from the first matching weekday.
        const dow = t.cadence.dayOfWeek;
        if (!Number.isInteger(dow) || dow < 0 || dow > 6) {
          throw new Error(`recurring ${t.id}: invalid dayOfWeek ${dow}`);
        }
        let cur = firstWeekdayOnOrAfter(t.startDate, dow);
        // Safety bound: weekly horizon is bounded by effectiveEnd, but cap
        // iterations defensively in case of malformed input.
        let guard = 0;
        while (compareIso(cur, effectiveEnd) <= 0) {
          emit(cur);
          cur = addDays(cur, 7);
          if (++guard > 20_000) throw new Error(`recurring ${t.id}: weekly expansion runaway`);
        }
        break;
      }
    }
  }
  return out;
};

const nextMonthlyOccurrence = (current: IsoDate, day: number): IsoDate => {
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
  templates: ReadonlyArray<RecurringTemplate> = [],
): LedgerEntry[] => {
  // Invariant guard: recurringId IS NULL ⇔ occurrenceKey IS NULL
  for (const e of persisted) {
    if ((e.recurringId == null) !== (e.occurrenceKey == null)) {
      throw new Error(
        `ledger entry ${e.id}: recurringId and occurrenceKey must be both set or both null`,
      );
    }
  }

  // Drop any persisted entry whose occurrence has been skipped by the
  // template. Virtuals are already filtered by generateVirtualOccurrences.
  const skippedKeys = new Set<string>();
  for (const t of templates) {
    if (!t.skips) continue;
    for (const date of t.skips) {
      skippedKeys.add(occurrenceKeyOf(t.id, date));
    }
  }

  const overrideKeys = new Set<string>();
  for (const e of persisted) {
    if (e.occurrenceKey != null && !skippedKeys.has(e.occurrenceKey)) {
      overrideKeys.add(e.occurrenceKey);
    }
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
    // Debit cards behave like bank: filter by account.asOf since the charge
    // already affected the bank balance on its own date.
    if (card.mode === 'debit') return compareIso(e.date, account.asOf) > 0;
    return compareIso(e.date, card.asOf) > 0;
  };

  const merged: LedgerEntry[] = [];
  for (const v of virtuals) {
    if (v.occurrenceKey && overrideKeys.has(v.occurrenceKey)) continue;
    if (keep(v)) merged.push(v);
  }
  for (const p of persisted) {
    if (p.occurrenceKey && skippedKeys.has(p.occurrenceKey)) continue;
    if (keep(p)) merged.push(p);
  }
  return merged;
};

/**
 * Project a daily balance series from startDate to endDate (inclusive).
 * - bank entries hit the bank on their date.
 * - cc entries are aggregated per card per billing day into one synthetic
 *   "Credit card bill" charge. A charge dated ON the billing day belongs to
 *   that same day's bill (`firstBillingDayOnOrAfter`).
 * - Each card's `currentDebit` becomes a bank debit on
 *   `firstBillingDayStrictlyAfter(card.asOf, billingDay)` (the snapshot's
 *   outstanding is settled on the next bill strictly after `asOf`).
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
        source: {
          kind: 'ledger',
          entryId: e.id,
          ...(e.recurringId ? { recurringId: e.recurringId } : {}),
          ...(e.occurrenceKey ? { occurrenceKey: e.occurrenceKey } : {}),
        },
      });
    } else {
      const cardId = e.channel.slice(3);
      const card = cardById.get(cardId);
      if (!card) throw new Error(`unknown card ${cardId} on entry ${e.id}`);
      if (card.mode === 'debit') {
        // Debit card: charge hits the bank on its own date, no aggregation.
        if (compareIso(e.date, walkStart) <= 0) continue;
        pushBank(e.date, {
          description: e.description,
          amount: e.amount,
          source: {
            kind: 'ledger',
            entryId: e.id,
            ...(e.recurringId ? { recurringId: e.recurringId } : {}),
            ...(e.occurrenceKey ? { occurrenceKey: e.occurrenceKey } : {}),
          },
        });
        continue;
      }
      const billDate = firstBillingDayOnOrAfter(e.date, card.billingDayOfMonth);
      if (compareIso(billDate, walkStart) < 0) continue;
      if (compareIso(billDate, endDate) > 0) continue;
      pushCc(cardId, billDate, e);
    }
  }

  // For each card, emit a single bank row per billing date that combines
  // (a) the rolled-up opening currentDebit (if it falls on that date) with
  // (b) any individual cc-channel charges from the ledger billing that date.
  // Emitting them as one row prevents two confusing entries on the same day
  // for the same card, while keeping the per-charge breakdown attached via
  // billedEntries (rendered as expandable sub-rows in the UI).
  type CardBillBucket = { entries: LedgerEntry[]; openingDebit: number };
  const cardBills = new Map<string, Map<IsoDate, CardBillBucket>>();
  const getBucket = (cardId: string, billDate: IsoDate): CardBillBucket => {
    let perDate = cardBills.get(cardId);
    if (!perDate) {
      perDate = new Map();
      cardBills.set(cardId, perDate);
    }
    let b = perDate.get(billDate);
    if (!b) {
      b = { entries: [], openingDebit: 0 };
      perDate.set(billDate, b);
    }
    return b;
  };

  // Seed buckets with currentDebit rollups (credit cards only).
  for (const card of cards) {
    if (card.mode === 'debit') continue;
    if (card.currentDebit === 0) continue;
    const billDate = firstBillingDayStrictlyAfter(card.asOf, card.billingDayOfMonth);
    if (compareIso(billDate, walkStart) < 0) continue;
    if (compareIso(billDate, endDate) > 0) continue;
    getBucket(card.id, billDate).openingDebit += card.currentDebit;
  }

  // Pour per-card cc charges into the same buckets.
  for (const [cardId, perDate] of ccByCardBillDate.entries()) {
    for (const [billDate, entries] of perDate.entries()) {
      const b = getBucket(cardId, billDate);
      for (const e of entries) b.entries.push(e);
    }
  }

  // Emit one consolidated cc-bill row per (card, billDate).
  for (const [cardId, perDate] of cardBills.entries()) {
    const card = cardById.get(cardId);
    if (!card) continue;
    for (const [billDate, b] of perDate.entries()) {
      const entriesTotal = b.entries.reduce((s, e) => s + e.amount, 0);
      const amount = entriesTotal - b.openingDebit;
      const parts: string[] = [];
      if (b.openingDebit > 0) parts.push('opening balance');
      if (b.entries.length > 0) {
        parts.push(`${b.entries.length} charge${b.entries.length === 1 ? '' : 's'}`);
      }
      const summary = parts.length > 0 ? parts.join(' + ') : '0 charges';
      pushBank(billDate, {
        description: `Credit card bill (${card.name}, ${summary})`,
        amount,
        source: { kind: 'cc-bill', cardId, billedEntries: b.entries.slice() },
      });
    }
  }

  // Walk from walkStart (the asOf date) so charges between asOf and today are
  // applied to the bank balance. Emit forecast days from visibleStart onward,
  // and separately collect the already-elapsed days of the current anchor
  // period (from the period's anchor start, or asOf if later) so the UI can
  // chart the part of the period that has already passed.
  const periodStart = currentPeriodAnchorStart(today);
  const days: DailyProjection[] = [];
  const priorDays: DailyProjection[] = [];
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
        isAnchor: d === ANCHOR_DAY_OF_MONTH,
      });
    } else if (compareIso(cur, periodStart) >= 0) {
      const { d } = parseIso(cur);
      priorDays.push({
        date: cur,
        balance,
        delta,
        charges,
        isAnchor: d === ANCHOR_DAY_OF_MONTH,
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
    const card = cardById.get(cardId);
    // Debit cards don't accumulate outstanding — each charge already hit the bank.
    if (card?.mode === 'debit') continue;
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
    const isDebit = card.mode === 'debit';
    let outstanding = isDebit ? 0 : card.currentDebit;

    const perDate = ccChargesByCardDate.get(card.id);
    let cur = walkStart;
    let openingDebitForResult = isDebit ? 0 : card.currentDebit;
    while (compareIso(cur, endDate) <= 0) {
      const accrued = perDate?.get(cur) ?? 0;
      outstanding += accrued;
      const { d } = parseIso(cur);
      const isBillingDay = !isDebit && d === card.billingDayOfMonth;
      // On the billing day, debt is settled at end of day.
      if (isBillingDay && compareIso(cur, card.asOf) > 0) {
        outstanding = 0;
      }
      if (compareIso(cur, visibleStart) >= 0) {
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
      snapshotDebit: isDebit ? 0 : card.currentDebit,
      openingDebit: openingDebitForResult,
      days: dayList,
    };
  });

  return {
    startDate: visibleStart, endDate, days, priorDays, status, minBalance, minBalanceDate,
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
  const virtualStart = input.cards.reduce(
    (start, card) =>
      card.mode !== 'debit' && compareIso(card.asOf, start) < 0 ? card.asOf : start,
    input.account.asOf,
  );
  const virtuals = generateVirtualOccurrences(input.templates, virtualStart, endDate);
  const effective = mergeWithOverrides(virtuals, input.persisted, input.account, input.cards, input.templates);
  return project(effective, input.account, input.cards, input.settings, input.today);
};
