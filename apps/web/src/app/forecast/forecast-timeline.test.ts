import { describe, expect, it } from 'vitest';
import {
  forecast,
  occurrenceKeyOf,
  type CreditCard,
  type LedgerEntry,
  type Settings,
} from '@expenses/shared';
import {
  buildCurrentPeriodDays,
  buildForecastTimeline,
  type ChargeItem,
} from './forecast-timeline';

const settings: Settings = {
  threshold: 2000,
  timezone: 'Asia/Jerusalem',
  horizonMonths: 2,
  currency: 'ILS',
};

const creditCard: CreditCard = {
  id: 'visa',
  name: 'Visa',
  currentDebit: 300,
  asOf: '2026-05-30',
  billingDayOfMonth: 2,
};

const installmentTemplate = {
  id: 'installment-phone',
  description: 'Phone installment',
  amount: -200,
  channel: 'cc:visa' as const,
  startDate: '2026-05-05',
  endDate: '2026-07-05',
  cadence: { kind: 'monthly' as const, day: 5, monthEndPolicy: 'clamp' as const },
};

const persistedCharge: LedgerEntry = {
  id: 'cc-groceries',
  description: 'Groceries',
  amount: -100,
  channel: 'cc:visa',
  date: '2026-05-20',
  status: 'pending',
};

const ccBillOn = (items: readonly ChargeItem[], date: string): ChargeItem => {
  const bill = items.find((item) => item.channel === 'cc' && item.date === date);
  expect(bill).toBeDefined();
  return bill!;
};

describe('forecast timeline', () => {
  it('itemizes current cc bill charges from the full billing cycle and greys only past rows', () => {
    const result = forecast({
      persisted: [persistedCharge],
      templates: [installmentTemplate],
      account: { bankBalance: 10_000, asOf: '2026-05-30' },
      cards: [creditCard],
      settings,
      today: '2026-05-30',
    });

    const timeline = buildForecastTimeline({
      forecast: result,
      threshold: settings.threshold,
      filter: 'all',
      ledger: [persistedCharge],
      templates: [installmentTemplate],
      cards: [creditCard],
      todayIso: '2026-05-30',
    }).filter((item): item is ChargeItem => item.kind === 'charge');

    const currentBill = ccBillOn(timeline, '2026-06-02');
    expect(currentBill.amount).toBe(-300);
    expect(currentBill.billedEntries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          date: '2026-05-05',
          description: 'Phone installment',
          amount: -200,
          past: true,
          recurringId: 'installment-phone',
          progress: { paid: 1, total: 3 },
          fullPrice: -600,
        }),
        expect.objectContaining({
          date: '2026-05-20',
          description: 'Groceries',
          amount: -100,
          past: true,
        }),
      ]),
    );

    const nextBill = ccBillOn(timeline, '2026-07-02');
    expect(nextBill.amount).toBe(-200);
    expect(nextBill.billedEntries).toEqual([
      expect.objectContaining({
        date: '2026-06-05',
        description: 'Phone installment',
        amount: -200,
        recurringId: 'installment-phone',
        progress: { paid: 2, total: 3 },
        fullPrice: -600,
      }),
    ]);
    expect(nextBill.billedEntries?.[0]).not.toHaveProperty('past');
  });

  it('exposes installment full price on a bank-channel charge (stored value wins over derived)', () => {
    // Stored fullPrice (-7663.10) must override the amount × count fallback.
    const arnona = {
      id: 'arnona',
      description: 'арнона',
      amount: -638.59,
      channel: 'bank' as const,
      startDate: '2026-06-02',
      endDate: '2027-05-02',
      cadence: { kind: 'monthly' as const, day: 2, monthEndPolicy: 'clamp' as const },
      fullPrice: -7663.1,
    };
    const result = forecast({
      persisted: [],
      templates: [arnona],
      account: { bankBalance: 10_000, asOf: '2026-06-01' },
      cards: [],
      settings,
      today: '2026-06-01',
    });
    const timeline = buildForecastTimeline({
      forecast: result,
      threshold: settings.threshold,
      filter: 'all',
      ledger: [],
      templates: [arnona],
      cards: [],
      todayIso: '2026-06-01',
    }).filter((item): item is ChargeItem => item.kind === 'charge');

    const charge = timeline.find((c) => c.recurringId === 'arnona');
    expect(charge).toBeDefined();
    expect(charge!.progress).toEqual({ paid: 1, total: 12 });
    expect(charge!.fullPrice).toBe(-7663.1);
  });

  it('leaves fullPrice null for open-ended recurring charges', () => {
    const salary = {
      id: 'salary',
      description: 'salary',
      amount: 15_000,
      channel: 'bank' as const,
      startDate: '2026-06-01',
      cadence: { kind: 'monthly' as const, day: 1, monthEndPolicy: 'clamp' as const },
    };
    const result = forecast({
      persisted: [],
      templates: [salary],
      account: { bankBalance: 10_000, asOf: '2026-06-01' },
      cards: [],
      settings,
      today: '2026-06-01',
    });
    const timeline = buildForecastTimeline({
      forecast: result,
      threshold: settings.threshold,
      filter: 'all',
      ledger: [],
      templates: [salary],
      cards: [],
      todayIso: '2026-06-01',
    }).filter((item): item is ChargeItem => item.kind === 'charge');

    const charge = timeline.find((c) => c.recurringId === 'salary');
    expect(charge).toBeDefined();
    expect(charge!.fullPrice == null).toBe(true);
  });

  it('treats a post-asOf installment that bills the opening cycle as accounted (already in currentDebit)', () => {
    // Installment occurrence falls AFTER asOf but bills on the opening cycle
    // (2026-06-02): currentDebit already includes it, so it must render as a
    // past sub-row and be excluded from the additive bill amount.
    const openingInstallment = {
      id: 'installment-fridge',
      description: 'Fridge installment',
      amount: -200,
      channel: 'cc:visa' as const,
      startDate: '2026-06-01',
      endDate: '2026-09-01',
      cadence: { kind: 'monthly' as const, day: 1, monthEndPolicy: 'clamp' as const },
    };
    // Open-ended recurring also billing the opening cycle stays additive.
    const openEnded = {
      id: 'water',
      description: 'Water',
      amount: -50,
      channel: 'cc:visa' as const,
      startDate: '2026-06-01',
      cadence: { kind: 'monthly' as const, day: 1, monthEndPolicy: 'clamp' as const },
    };

    const result = forecast({
      persisted: [],
      templates: [openingInstallment, openEnded],
      account: { bankBalance: 10_000, asOf: '2026-05-30' },
      cards: [creditCard],
      settings,
      today: '2026-05-30',
    });

    const timeline = buildForecastTimeline({
      forecast: result,
      threshold: settings.threshold,
      filter: 'all',
      ledger: [],
      templates: [openingInstallment, openEnded],
      cards: [creditCard],
      todayIso: '2026-05-30',
    }).filter((item): item is ChargeItem => item.kind === 'charge');

    const openingBill = ccBillOn(timeline, '2026-06-02');
    // currentDebit (300) covers the installment (200); only the open-ended
    // recurring (50) is additive: amount = -(300 + 50).
    expect(openingBill.amount).toBe(-350);
    // The installment renders as a past sub-row; the open-ended one does not.
    expect(openingBill.billedEntries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          description: 'Fridge installment',
          amount: -200,
          past: true,
          recurringId: 'installment-fridge',
        }),
        expect.objectContaining({ description: 'Water', amount: -50 }),
      ]),
    );
    expect(
      openingBill.billedEntries?.find((r) => r.description === 'Water'),
    ).not.toHaveProperty('past');
    // Opening balance sub-row = currentDebit minus the accounted installment.
    expect(openingBill.billedEntries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          description: 'Opening balance (from Excel snapshot)',
          amount: -100,
          past: true,
        }),
      ]),
    );
  });

  it('past opening bill: a post-asOf installment already in currentDebit is accounted, not double-added', () => {
    // Stale snapshot: asOf is in the past, the opening bill (2026-07-02) has
    // already happened, and a fixed-term installment billed it.
    const staleCard: CreditCard = {
      id: 'visa', name: 'Visa', currentDebit: 300, asOf: '2026-06-28', billingDayOfMonth: 2,
    };
    const installment = {
      id: 'installment-tv',
      description: 'TV installment',
      amount: -200,
      channel: 'cc:visa' as const,
      startDate: '2026-07-01',
      endDate: '2026-12-01',
      cadence: { kind: 'monthly' as const, day: 1, monthEndPolicy: 'clamp' as const },
    };
    const result = forecast({
      persisted: [],
      templates: [installment],
      account: { bankBalance: 10_000, asOf: '2026-06-28' },
      cards: [staleCard],
      settings,
      today: '2026-07-05',
    });

    const timeline = buildForecastTimeline({
      forecast: result,
      threshold: settings.threshold,
      filter: 'all',
      ledger: [],
      templates: [installment],
      cards: [staleCard],
      todayIso: '2026-07-05',
    }).filter((item): item is ChargeItem => item.kind === 'charge');

    const pastBill = ccBillOn(timeline, '2026-07-02');
    // currentDebit (300) already covers the installment (200): amount = -300,
    // NOT -500.
    expect(pastBill.amount).toBe(-300);
    expect(pastBill.past).toBe(true);
    expect(pastBill.billedEntries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          description: 'TV installment',
          amount: -200,
          past: true,
          recurringId: 'installment-tv',
        }),
        expect.objectContaining({
          description: 'Opening balance (from Excel snapshot)',
          amount: -100,
          past: true,
        }),
      ]),
    );
  });

  it('does not show skipped installments in current or next cc bill breakdowns', () => {
    const skippedTemplate = {
      ...installmentTemplate,
      skips: ['2026-05-05', '2026-06-05'],
    };
    const result = forecast({
      persisted: [],
      templates: [skippedTemplate],
      account: { bankBalance: 10_000, asOf: '2026-05-30' },
      cards: [{ ...creditCard, currentDebit: 0 }],
      settings,
      today: '2026-05-30',
    });

    const timeline = buildForecastTimeline({
      forecast: result,
      threshold: settings.threshold,
      filter: 'all',
      ledger: [
        {
          id: 'skip-may',
          description: 'Phone installment',
          amount: 0,
          channel: 'cc:visa',
          date: '2026-05-05',
          status: 'pending',
          recurringId: 'installment-phone',
          occurrenceKey: occurrenceKeyOf('installment-phone', '2026-05-05'),
        },
      ],
      templates: [skippedTemplate],
      cards: [{ ...creditCard, currentDebit: 0 }],
      todayIso: '2026-05-30',
    }).filter((item): item is ChargeItem => item.kind === 'charge');

    expect(timeline.find((item) => item.date === '2026-06-02')).toBeUndefined();
    expect(timeline.find((item) => item.date === '2026-07-02')).toBeUndefined();
  });
});

describe('buildCurrentPeriodDays', () => {
  const baseSettings: Settings = {
    threshold: 0,
    timezone: 'Asia/Jerusalem',
    horizonMonths: 2,
    currency: 'ILS',
  };

  it('reconstructs the elapsed period back to the previous anchor when the snapshot is today', () => {
    const rent: LedgerEntry = {
      id: 'rent',
      description: 'Rent',
      amount: -3000,
      channel: 'bank',
      date: '2026-06-20',
      status: 'pending',
    };
    const result = forecast({
      persisted: [rent],
      templates: [],
      account: { bankBalance: 12_000, asOf: '2026-06-26' },
      cards: [],
      settings: baseSettings,
      today: '2026-06-26',
    });
    // The pipeline drops the pre-asOf charge, so there is no elapsed history.
    expect(result.priorDays).toHaveLength(0);
    expect(result.days[0]?.date).toBe('2026-06-26');

    const days = buildCurrentPeriodDays({
      forecast: result,
      ledger: [rent],
      templates: [],
      cards: [],
      todayIso: '2026-06-26',
    });

    // Starts at the previous anchor (the 10th), not today.
    expect(days[0]?.date).toBe('2026-06-10');
    expect(days[0]?.balance).toBe(15_000);

    const charged = days.find((d) => d.date === '2026-06-20');
    expect(charged?.delta).toBe(-3000);
    expect(charged?.balance).toBe(12_000);
    expect(charged?.charges.map((c) => c.description)).toContain('Rent');

    // Continuous with the projected line: the day before today equals today.
    const dayBeforeToday = days.find((d) => d.date === '2026-06-25');
    expect(dayBeforeToday?.balance).toBe(12_000);
    const todayDay = days.find((d) => d.date === '2026-06-26');
    expect(todayDay?.balance).toBe(12_000);

    // Forward part still runs through the next anchor (the 10th).
    expect(days.some((d) => d.date === '2026-07-10' && d.isAnchor)).toBe(true);
  });

  it('shows a flat elapsed line from the anchor when nothing happened yet this period', () => {
    const result = forecast({
      persisted: [],
      templates: [],
      account: { bankBalance: 12_000, asOf: '2026-06-26' },
      cards: [],
      settings: baseSettings,
      today: '2026-06-26',
    });

    const days = buildCurrentPeriodDays({
      forecast: result,
      ledger: [],
      templates: [],
      cards: [],
      todayIso: '2026-06-26',
    });

    expect(days[0]?.date).toBe('2026-06-10');
    expect(days.every((d) => d.date > '2026-07-10' || d.balance === 12_000)).toBe(true);
  });

  it('prefers the pipeline-provided elapsed days when the snapshot is in the past', () => {
    const rent: LedgerEntry = {
      id: 'rent',
      description: 'Rent',
      amount: -3000,
      channel: 'bank',
      date: '2026-06-20',
      status: 'pending',
    };
    const result = forecast({
      persisted: [rent],
      templates: [],
      account: { bankBalance: 15_000, asOf: '2026-06-18' },
      cards: [],
      settings: baseSettings,
      today: '2026-06-26',
    });
    expect(result.priorDays.length).toBeGreaterThan(0);

    const days = buildCurrentPeriodDays({
      forecast: result,
      ledger: [rent],
      templates: [],
      cards: [],
      todayIso: '2026-06-26',
    });

    // Cannot go earlier than the snapshot date — balances before it are unknown.
    expect(days[0]?.date).toBe('2026-06-18');
    expect(days.find((d) => d.date === '2026-06-20')?.balance).toBe(12_000);
  });
});
