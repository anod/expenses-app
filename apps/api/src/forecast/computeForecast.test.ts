import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { openDb } from '../db/openDb.js';
import { StateRepo } from '../db/stateRepo.js';
import { computeForecast } from './computeForecast.js';

const here = dirname(fileURLToPath(import.meta.url));
const migrationsDir = resolve(here, '..', '..', 'migrations');

describe('computeForecast', () => {
  it('empty DB → flat zero-balance forecast', () => {
    const db = openDb({ path: ':memory:', migrationsDir });
    const repo = new StateRepo(db);
    const result = computeForecast(repo);
    expect(result.days.length).toBeGreaterThan(0);
    expect(result.days.every((d) => d.balance === 0)).toBe(true);
    // default threshold 2000; min 0 < threshold → breach
    expect(result.status).toBe('breach');
  });

  it('end-to-end: account + card + recurring + persisted override', () => {
    const db = openDb({ path: ':memory:', migrationsDir });
    const repo = new StateRepo(db);
    repo.upsertAccount({ bankBalance: 50_000, asOf: '2026-05-15' });
    repo.upsertCard({
      id: 'visa', name: 'Visa', currentDebit: 3200,
      asOf: '2026-05-15', billingDayOfMonth: 2,
    });
    repo.upsertRecurring({
      id: 'mortgage', description: 'mortgage', amount: -5500, channel: 'bank',
      cadence: { kind: 'monthly', day: 10, monthEndPolicy: 'clamp' }, startDate: '2026-05-01',
    });
    repo.upsertLedger({
      id: 'inst1', description: 'installment', amount: -200,
      channel: 'cc:visa', date: '2026-06-15', status: 'pending',
    });
    const result = computeForecast(repo);
    const jun02 = result.days.find((d) => d.date === '2026-06-02');
    const jun10 = result.days.find((d) => d.date === '2026-06-10');
    const jul02 = result.days.find((d) => d.date === '2026-07-02');
    expect(jun02?.delta).toBe(-3200);
    expect(jun10?.delta).toBe(-5500);
    expect(jul02?.delta).toBe(-200);
    expect(result.status).toBeDefined();
  });
});
