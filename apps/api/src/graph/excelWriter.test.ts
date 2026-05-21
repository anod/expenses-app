import { describe, expect, it } from 'vitest';
import {
  addMonthsIso,
  colLetter,
  computeAnchors,
  formatAnchorHeader,
  parseDescription,
  rangeA1,
  renderAnchorSheet,
  renderStateRawSheet,
  type SyncState,
} from './excelWriter.js';

const makeState = (overrides: Partial<SyncState> = {}): SyncState => ({
  account: { bankBalance: 29900, asOf: '2026-05-10' },
  cards: [
    { id: 'cal', name: 'Cal', currentDebit: 11000, asOf: '2026-05-10', billingDayOfMonth: 2 },
  ],
  recurring: [
    {
      id: 'excel:r:_:zp:1',
      description: 'зп',
      amount: 26000,
      channel: 'bank',
      cadence: { kind: 'monthly', day: 1, monthEndPolicy: 'clamp' },
      startDate: '2026-05-01',
    },
    {
      id: 'excel:r:_:mortgage:10',
      description: 'машканта',
      amount: -11000,
      channel: 'bank',
      cadence: { kind: 'monthly', day: 10, monthEndPolicy: 'clamp' },
      startDate: '2026-05-10',
    },
  ],
  ledger: [
    {
      id: 'excel:l:cardbill:cal:2026-05',
      description: 'Cal bill',
      amount: -11000,
      channel: 'bank',
      date: '2026-06-02',
      status: 'pending',
    },
    {
      id: 'excel:l:cal:cal-debt:2026-06',
      description: '[cal] cal debt',
      amount: -1036,
      channel: 'bank',
      date: '2026-07-02',
      status: 'pending',
    },
  ],
  settings: { threshold: 2000, horizonMonths: 3, currency: 'ILS', timezone: 'Asia/Jerusalem' },
  ...overrides,
});

describe('colLetter', () => {
  it('maps 0..27 to A..AB', () => {
    expect(colLetter(0)).toBe('A');
    expect(colLetter(25)).toBe('Z');
    expect(colLetter(26)).toBe('AA');
    expect(colLetter(27)).toBe('AB');
  });
});

describe('rangeA1', () => {
  it('builds top-left anchored ranges', () => {
    expect(rangeA1(1, 1)).toBe('A1:A1');
    expect(rangeA1(3, 5)).toBe('A1:E3');
    expect(rangeA1(10, 27)).toBe('A1:AA10');
  });
});

describe('addMonthsIso', () => {
  it('rolls calendar months and clamps day-of-month', () => {
    expect(addMonthsIso('2026-05-10', 1)).toBe('2026-06-10');
    expect(addMonthsIso('2026-12-10', 1)).toBe('2027-01-10');
    expect(addMonthsIso('2026-01-31', 1)).toBe('2026-02-28');
    expect(addMonthsIso('2024-01-31', 1)).toBe('2024-02-29');
  });
});

describe('formatAnchorHeader', () => {
  it('renders Excel-style "DD-Mon-YY"', () => {
    expect(formatAnchorHeader('2026-05-10')).toBe('10-May-26');
    expect(formatAnchorHeader('2027-01-01')).toBe('01-Jan-27');
  });
});

describe('parseDescription', () => {
  it('splits "[source] label" and falls back to whole string', () => {
    expect(parseDescription('[cal] арнона')).toEqual({ source: 'cal', label: 'арнона' });
    expect(parseDescription('songsterr')).toEqual({ source: '', label: 'songsterr' });
  });
});

describe('computeAnchors', () => {
  it('emits asOf + horizonMonths anchors in ascending order', () => {
    const s = makeState();
    expect(computeAnchors(s)).toEqual(['2026-05-10', '2026-06-10', '2026-07-10', '2026-08-10']);
  });
});

describe('renderAnchorSheet', () => {
  it('contains a header, balance row, and rows for each (source,label)', () => {
    const grid = renderAnchorSheet(makeState());
    expect(grid[0]).toEqual(['source', 'day', 'description', '10-May-26', '10-Jun-26', '10-Jul-26', '10-Aug-26']);
    // Balance row first column reflects asOf snapshot.
    expect(grid[1]?.[0]).toBe('');
    expect(grid[1]?.[2]).toBe('счет');
    expect(grid[1]?.[3]).toBe(29900);
  });

  it('routes card-bill ledger entries back to the «карта потрачено» row for the card', () => {
    const grid = renderAnchorSheet(makeState());
    const billRow = grid.find((r) => r[2] === 'карта потрачено');
    expect(billRow?.[0]).toBe('cal');
    // -11000 falls in the May 10 → Jun 10 period (column index 3 = first anchor col).
    expect(billRow?.[3]).toBe(-11000);
  });

  it('applies recurring once per anchor period', () => {
    const grid = renderAnchorSheet(makeState());
    const mortgage = grid.find((r) => r[2] === 'машканта');
    // 3 horizon periods → 3 non-empty values, last col stays blank (no period after it).
    expect(mortgage?.slice(3)).toEqual([-11000, -11000, -11000, '']);
  });

  it('renders monthly prediction templates into anchor periods', () => {
    const grid = renderAnchorSheet(makeState({
      recurring: [
        ...makeState().recurring,
        {
          id: 'pred',
          description: '[cal] супер',
          amount: -1120,
          channel: 'cc:cal',
          cadence: { kind: 'monthly_prediction' },
          startDate: '2026-06-10',
        },
      ],
    }));
    const row = grid.find((r) => r[2] === 'супер');
    expect(row?.[0]).toBe('cal');
    expect(row?.[1]).toBe('');
    expect(row?.slice(3)).toEqual([-1120, -1120, -1120, '']);
  });

  it('respects template skips when rendering anchor periods', () => {
    const grid = renderAnchorSheet(makeState({
      recurring: [{
        id: 'water',
        description: '[cal] вода',
        amount: -132,
        channel: 'cc:cal',
        cadence: { kind: 'monthly', day: 28, monthEndPolicy: 'clamp' },
        startDate: '2026-05-28',
        endDate: '2026-08-28',
        skips: ['2026-06-28'],
      }],
      ledger: [],
    }));
    const row = grid.find((r) => r[2] === 'вода');
    expect(row?.slice(3)).toEqual([-132, '', -132, '']);
  });

  it('aggregates weekly templates into each anchor period', () => {
    const grid = renderAnchorSheet(makeState({
      recurring: [{
        id: 'psych',
        description: '[cal] психолог',
        amount: -200,
        channel: 'cc:cal',
        cadence: { kind: 'weekly', dayOfWeek: 5 },
        startDate: '2026-05-15',
      }],
      ledger: [],
    }));
    const row = grid.find((r) => r[2] === 'психолог');
    expect(row?.[0]).toBe('cal');
    expect(row?.[1]).toBe('');
    expect(row?.slice(3)).toEqual([-800, -1000, -800, '']);
  });

  it('balance row carries forward (each anchor = prior + sum of prior column)', () => {
    const s = makeState({
      account: { bankBalance: 1000, asOf: '2026-05-10' },
      recurring: [],
      cards: [],
      ledger: [
        {
          id: 'l-x',
          description: 'x',
          amount: -100,
          channel: 'bank',
          date: '2026-06-01',
          status: 'pending',
        },
      ],
      settings: { threshold: 0, horizonMonths: 2, currency: 'ILS', timezone: 'Asia/Jerusalem' },
    });
    const grid = renderAnchorSheet(s);
    // balance row: [, , счет, 1000 (asOf), 900 (after -100), 900 (no more deltas)]
    expect(grid[1]?.slice(3)).toEqual([1000, 900, 900]);
  });

  it('skips cleared ledger entries', () => {
    const s = makeState({
      recurring: [],
      cards: [],
      ledger: [
        {
          id: 'l-1',
          description: '[cal] арнона',
          amount: -697,
          channel: 'bank',
          date: '2026-06-04',
          status: 'cleared',
        },
      ],
    });
    const grid = renderAnchorSheet(s);
    expect(grid.find((r) => r[2] === 'арнона')).toBeUndefined();
  });
});

describe('renderStateRawSheet', () => {
  it('emits sections for account, cards, recurring, ledger, settings', () => {
    const grid = renderStateRawSheet(makeState());
    const headerCells = grid.map((row) => row[0]);
    expect(headerCells).toContain('# account');
    expect(headerCells).toContain('# cards');
    expect(headerCells).toContain('# recurring');
    expect(headerCells).toContain('# ledger');
    expect(headerCells).toContain('# settings');
  });

  it('keeps every row the same width (rectangular grid)', () => {
    const grid = renderStateRawSheet(makeState());
    const w = grid[0]!.length;
    for (const row of grid) expect(row.length).toBe(w);
  });

  it('warns when non-monthly templates are excluded from raw export', () => {
    const grid = renderStateRawSheet(makeState({
      recurring: [
        ...makeState().recurring,
        {
          id: 'pred',
          description: 'supermarket prediction',
          amount: -1500,
          channel: 'bank',
          cadence: { kind: 'monthly_prediction' },
          startDate: '2026-05-01',
        },
      ],
    }));
    expect(grid.some((row) =>
      String(row[0]).includes('non-monthly templates excluded'),
    )).toBe(true);
  });

  it('includes card mode in the raw cards section', () => {
    const grid = renderStateRawSheet(makeState({
      cards: [
        { id: 'cal', name: 'Cal', currentDebit: 0, asOf: '2026-05-10', billingDayOfMonth: 2, mode: 'debit' },
      ],
    }));
    const header = grid.find((row) => row[0] === 'id' && row[1] === 'name' && row[5] === 'mode');
    expect(header).toBeDefined();
    const cardRow = grid.find((row) => row[0] === 'cal' && row[1] === 'Cal');
    expect(cardRow?.[5]).toBe('debit');
  });
});
