import { describe, expect, it } from 'vitest';
import { buildDemoState, DEMO_PREFIX } from './seed.js';

describe('buildDemoState', () => {
  const today = new Date('2026-06-15T12:00:00Z');

  it('produces a complete, internally consistent snapshot', () => {
    const s = buildDemoState({ today });
    expect(s.account.bankBalance).toBeGreaterThan(0);
    expect(s.account.asOf).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(s.cards.length).toBeGreaterThanOrEqual(2);
    expect(s.recurring.length).toBeGreaterThanOrEqual(5);
    expect(s.ledger.length).toBeGreaterThanOrEqual(5);
    expect(s.settings.currency).toBe('ILS');
    expect(s.settings.threshold).toBeGreaterThan(0);
  });

  it('prefixes every id with demo:', () => {
    const s = buildDemoState({ today });
    for (const c of s.cards) expect(c.id.startsWith(DEMO_PREFIX)).toBe(true);
    for (const r of s.recurring) expect(r.id.startsWith(DEMO_PREFIX)).toBe(true);
    for (const e of s.ledger) expect(e.id.startsWith(DEMO_PREFIX)).toBe(true);
  });

  it('cc-channel entries reference an existing demo card id', () => {
    const s = buildDemoState({ today });
    const cardIds = new Set(s.cards.map((c) => c.id));
    const ccChannels = [
      ...s.ledger.map((e) => e.channel),
      ...s.recurring.map((r) => r.channel),
    ].filter((ch) => ch.startsWith('cc:'));
    expect(ccChannels.length).toBeGreaterThan(0);
    for (const ch of ccChannels) {
      expect(cardIds.has(ch.slice(3))).toBe(true);
    }
  });

  it('is deterministic for a fixed today', () => {
    const a = buildDemoState({ today });
    const b = buildDemoState({ today });
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it('anchors all dates relative to the provided today', () => {
    const s = buildDemoState({ today });
    const todayIso = '2026-06-15';
    expect(s.account.asOf).toBe(todayIso);
    for (const c of s.cards) expect(c.asOf).toBe(todayIso);
    for (const e of s.ledger) {
      expect(e.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    }
  });
});
