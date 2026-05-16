import { describe, expect, it } from 'vitest';
import {
  forecast,
  generateVirtualOccurrences,
  mergeWithOverrides,
  project,
  type Account,
  type CreditCard,
  type LedgerEntry,
  type RecurringTemplate,
  type Settings,
  occurrenceKeyOf,
} from './index.js';

const TODAY = '2026-05-16';

const baseSettings: Settings = {
  threshold: 2000,
  timezone: 'Asia/Jerusalem',
  horizonMonths: 6,
  currency: 'ILS',
};

const acct = (bankBalance = 10_000, asOf = TODAY): Account => ({ bankBalance, asOf });

const visa: CreditCard = {
  id: 'visa',
  name: 'Visa',
  currentDebit: 0,
  asOf: TODAY,
  billingDayOfMonth: 2,
};

describe('forecast pipeline', () => {
  // 1
  it('empty state: balance flat at bankBalance', () => {
    const r = project([], acct(5000), [], baseSettings, TODAY);
    expect(r.days[0].balance).toBe(5000);
    expect(r.days[r.days.length - 1].balance).toBe(5000);
    expect(r.minBalance).toBe(5000);
    expect(r.status).toBe('safe');
  });

  // 2
  it('single mortgage on the 10th drops balance', () => {
    const entry: LedgerEntry = {
      id: 'e1', description: 'mortgage', amount: -5500, channel: 'bank',
      date: '2026-06-10', status: 'pending',
    };
    const r = project([entry], acct(10_000), [], baseSettings, TODAY);
    const d = r.days.find((x) => x.date === '2026-06-10')!;
    expect(d.balance).toBe(4500);
    expect(d.delta).toBe(-5500);
    expect(d.isAnchor).toBe(true);
  });

  // 3
  it('currentDebit asOf=billingDay → next month (strictly-after)', () => {
    const card: CreditCard = { ...visa, currentDebit: 3200, asOf: '2026-05-02' };
    const r = project([], acct(20_000, '2026-05-02'), [card], baseSettings, '2026-05-02');
    expect(r.days.find((x) => x.date === '2026-05-02')!.delta).toBe(0);
    expect(r.days.find((x) => x.date === '2026-06-02')!.delta).toBe(-3200);
  });

  // 4
  it('cc charge dated 2026-05-15 → bank 2026-06-02', () => {
    const card = { ...visa, asOf: '2026-05-01' };
    const entry: LedgerEntry = {
      id: 'c1', description: 'groceries', amount: -300, channel: 'cc:visa',
      date: '2026-05-15', status: 'pending',
    };
    const r = project([entry], acct(20_000, '2026-05-01'), [card], baseSettings, '2026-05-01');
    expect(r.days.find((x) => x.date === '2026-06-02')!.delta).toBe(-300);
  });

  // 5
  it('cc charge ON billing day rolls to next month', () => {
    const card = { ...visa, asOf: '2026-05-01' };
    const entry: LedgerEntry = {
      id: 'c1', description: 'on-bill-day', amount: -100, channel: 'cc:visa',
      date: '2026-06-02', status: 'pending',
    };
    const r = project([entry], acct(20_000, '2026-05-01'), [card], baseSettings, '2026-05-01');
    expect(r.days.find((x) => x.date === '2026-06-02')!.delta).toBe(0);
    expect(r.days.find((x) => x.date === '2026-07-02')!.delta).toBe(-100);
  });

  // 6
  it('installment plan: 6×-200 on the 15th → 6 bank debits on the 2nd', () => {
    const card = { ...visa, asOf: '2026-05-14' };
    const entries: LedgerEntry[] = ['06', '07', '08', '09', '10', '11'].map((mm, i) => ({
      id: `inst${i}`, description: 'installment', amount: -200,
      channel: 'cc:visa', date: `2026-${mm}-15`, status: 'pending',
    }));
    const longHorizon: Settings = { ...baseSettings, horizonMonths: 8 };
    const r = project(entries, acct(20_000, '2026-05-14'), [card], longHorizon, '2026-05-14');
    for (const mm of ['07', '08', '09', '10', '11', '12']) {
      expect(r.days.find((x) => x.date === `2026-${mm}-02`)!.delta).toBe(-200);
    }
  });

  // 7
  it('concrete combo: currentDebit 3200 + 6× -200 installment', () => {
    const card: CreditCard = { ...visa, currentDebit: 3200, asOf: '2026-05-15' };
    const entries: LedgerEntry[] = ['06', '07', '08', '09', '10', '11'].map((mm, i) => ({
      id: `inst${i}`, description: 'installment', amount: -200,
      channel: 'cc:visa', date: `2026-${mm}-15`, status: 'pending',
    }));
    const longHorizon: Settings = { ...baseSettings, horizonMonths: 8 };
    const r = project(entries, acct(50_000, '2026-05-15'), [card], longHorizon, '2026-05-15');
    expect(r.days.find((x) => x.date === '2026-06-02')!.delta).toBe(-3200);
    for (const mm of ['07', '08', '09', '10', '11', '12']) {
      expect(r.days.find((x) => x.date === `2026-${mm}-02`)!.delta).toBe(-200);
    }
  });

  // 8
  it('recurring salary on the 1st raises balance', () => {
    const tmpl: RecurringTemplate = {
      id: 'sal', description: 'salary', amount: 15_000, channel: 'bank',
      day: 1, startDate: '2026-05-01', monthEndPolicy: 'clamp',
    };
    const r = forecast({
      templates: [tmpl], persisted: [], account: acct(1000), cards: [],
      settings: baseSettings, today: TODAY,
    });
    expect(r.days.find((x) => x.date === '2026-06-01')!.delta).toBe(15_000);
  });

  // 9
  it('recurring day=31 clamps in February', () => {
    const tmpl: RecurringTemplate = {
      id: 't', description: 'end-month', amount: -100, channel: 'bank',
      day: 31, startDate: '2026-01-01', monthEndPolicy: 'clamp',
    };
    const virtuals = generateVirtualOccurrences([tmpl], '2026-01-01', '2026-03-31');
    const dates = virtuals.map((v) => v.date);
    expect(dates).toEqual(['2026-01-31', '2026-02-28', '2026-03-31']);
  });

  // 10
  it('persisted override replaces virtual with same occurrenceKey', () => {
    const tmpl: RecurringTemplate = {
      id: 'rent', description: 'rent', amount: -3000, channel: 'bank',
      day: 1, startDate: '2026-05-01', monthEndPolicy: 'clamp',
    };
    const persisted: LedgerEntry[] = [{
      id: 'p1', description: 'rent (raised)', amount: -3200, channel: 'bank',
      date: '2026-06-01', status: 'pending',
      recurringId: 'rent', occurrenceKey: occurrenceKeyOf('rent', '2026-06-01'),
    }];
    const r = forecast({
      templates: [tmpl], persisted, account: acct(20_000), cards: [],
      settings: baseSettings, today: TODAY,
    });
    expect(r.days.find((x) => x.date === '2026-06-01')!.delta).toBe(-3200);
    // not double-counted:
    expect(r.days.find((x) => x.date === '2026-06-01')!.charges).toHaveLength(1);
  });

  // 11
  it('cleared entries are ignored on both channels', () => {
    const card = { ...visa, asOf: '2026-05-10' };
    const persisted: LedgerEntry[] = [
      { id: 'a', description: 'x', amount: -500, channel: 'bank', date: '2026-06-01', status: 'cleared' },
      { id: 'b', description: 'y', amount: -200, channel: 'cc:visa', date: '2026-05-20', status: 'cleared' },
    ];
    const r = project(persisted, acct(10_000, '2026-05-10'), [card], baseSettings, '2026-05-10');
    expect(r.days.find((x) => x.date === '2026-06-01')!.delta).toBe(0);
    expect(r.days.find((x) => x.date === '2026-06-02')!.delta).toBe(0);
  });

  // 12
  it('bank entries dated before account.asOf are dropped', () => {
    const persisted: LedgerEntry[] = [
      { id: 'a', description: 'old', amount: -500, channel: 'bank', date: '2026-05-10', status: 'pending' },
    ];
    const r = mergeWithOverrides([], persisted, acct(10_000, '2026-05-15'), []);
    expect(r).toEqual([]);
  });

  // 13
  it('cc entries dated on/before card.asOf are dropped', () => {
    const card = { ...visa, asOf: '2026-05-15' };
    const persisted: LedgerEntry[] = [
      { id: 'a', description: 'same-day', amount: -10, channel: 'cc:visa', date: '2026-05-15', status: 'pending' },
      { id: 'b', description: 'after', amount: -20, channel: 'cc:visa', date: '2026-05-16', status: 'pending' },
    ];
    const r = mergeWithOverrides([], persisted, acct(10_000, '2026-05-15'), [card]);
    expect(r.map((e) => e.id)).toEqual(['b']);
  });

  // 14
  it('future asOf is rejected', () => {
    expect(() => project([], acct(1000, '2030-01-01'), [], baseSettings, TODAY)).toThrow(/future/);
  });

  // 15
  it('same-day salary + mortgage produces aggregated delta with both charges visible', () => {
    const entries: LedgerEntry[] = [
      { id: 's', description: 'salary', amount: 15_000, channel: 'bank', date: '2026-06-01', status: 'pending' },
      { id: 'm', description: 'mortgage', amount: -5500, channel: 'bank', date: '2026-06-01', status: 'pending' },
    ];
    const r = project(entries, acct(0), [], baseSettings, TODAY);
    const d = r.days.find((x) => x.date === '2026-06-01')!;
    expect(d.delta).toBe(9500);
    expect(d.charges.map((c) => c.description).sort()).toEqual(['mortgage', 'salary']);
  });

  // 16
  it('status thresholds: breach / warning / safe', () => {
    // breach: min = 1500 < threshold (2000)
    const breach = project(
      [{ id: 'e', description: 'x', amount: -8500, channel: 'bank', date: '2026-06-01', status: 'pending' }],
      acct(10_000), [], baseSettings, TODAY,
    );
    expect(breach.status).toBe('breach');

    // warning: min between threshold and 1.2*threshold => e.g., 2200
    const warning = project(
      [{ id: 'e', description: 'x', amount: -7800, channel: 'bank', date: '2026-06-01', status: 'pending' }],
      acct(10_000), [], baseSettings, TODAY,
    );
    expect(warning.status).toBe('warning');

    // safe: min >= 1.2*threshold = 2400
    const safe = project(
      [{ id: 'e', description: 'x', amount: -7000, channel: 'bank', date: '2026-06-01', status: 'pending' }],
      acct(10_000), [], baseSettings, TODAY,
    );
    expect(safe.status).toBe('safe');
  });

  // 17
  it('every 10th day flagged as anchor', () => {
    const r = project([], acct(5000), [], baseSettings, TODAY);
    const anchors = r.days.filter((d) => d.isAnchor);
    expect(anchors.length).toBeGreaterThan(0);
    expect(anchors.every((d) => d.date.endsWith('-10'))).toBe(true);
  });

  // 18 (semantic): cc bill aggregates into single synthetic charge
  it('cc bill aggregation: multiple cc charges roll into one bank line per billing day', () => {
    const card = { ...visa, asOf: '2026-05-10' };
    const entries: LedgerEntry[] = [
      { id: 'c1', description: 'A', amount: -100, channel: 'cc:visa', date: '2026-05-20', status: 'pending' },
      { id: 'c2', description: 'B', amount: -50, channel: 'cc:visa', date: '2026-05-25', status: 'pending' },
    ];
    const r = project(entries, acct(20_000, '2026-05-10'), [card], baseSettings, '2026-05-10');
    const d = r.days.find((x) => x.date === '2026-06-02')!;
    expect(d.delta).toBe(-150);
    expect(d.charges).toHaveLength(1);
    expect(d.charges[0].source.kind).toBe('cc-bill');
    if (d.charges[0].source.kind === 'cc-bill') {
      expect(d.charges[0].source.billedEntries.map((e) => e.id).sort()).toEqual(['c1', 'c2']);
    }
  });

  // Invariant: occurrenceKey & recurringId both null or both set
  it('rejects entry with only one of recurringId/occurrenceKey', () => {
    const bad: LedgerEntry = {
      id: 'bad', description: 'x', amount: -10, channel: 'bank',
      date: '2026-06-01', status: 'pending', recurringId: 'r',
    };
    expect(() => mergeWithOverrides([], [bad], acct(), [])).toThrow(/recurringId/);
  });
});
