import { describe, expect, it } from 'vitest';
import {
  forecast,
  occurrenceKeyOf,
  type CreditCard,
  type LedgerEntry,
  type Settings,
} from '@expenses/shared';
import { buildForecastTimeline, type ChargeItem } from './forecast-timeline';

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
      }),
    ]);
    expect(nextBill.billedEntries?.[0]).not.toHaveProperty('past');
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
