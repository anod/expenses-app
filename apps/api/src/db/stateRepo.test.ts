import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeEach, describe, expect, it } from 'vitest';
import { openDb } from './openDb.js';
import { StateRepo } from './stateRepo.js';

const here = dirname(fileURLToPath(import.meta.url));
const migrationsDir = resolve(here, '..', '..', 'migrations');

describe('StateRepo', () => {
  let repo: StateRepo;

  beforeEach(() => {
    const db = openDb({ path: ':memory:', migrationsDir });
    repo = new StateRepo(db);
  });

  it('account: default + upsert + read', () => {
    const def = repo.getAccount();
    expect(def.bankBalance).toBe(0);
    repo.upsertAccount({ bankBalance: 12_345, asOf: '2026-05-16' });
    expect(repo.getAccount()).toEqual({ bankBalance: 12_345, asOf: '2026-05-16' });
  });

  it('card: upsert + list + delete', () => {
    repo.upsertCard({
      id: 'visa', name: 'Visa', currentDebit: 100, asOf: '2026-05-10', billingDayOfMonth: 2,
    });
    expect(repo.listCards()).toHaveLength(1);
    repo.deleteCard('visa');
    expect(repo.listCards()).toEqual([]);
  });

  it('ledger: standalone (no recurringId/occurrenceKey)', () => {
    repo.upsertLedger({
      id: 'e1', description: 'rent', amount: -3000, channel: 'bank',
      date: '2026-06-01', status: 'pending',
    });
    const list = repo.listLedger();
    expect(list[0]?.recurringId).toBeUndefined();
    expect(list[0]?.occurrenceKey).toBeUndefined();
  });

  it('ledger: override (both recurringId and occurrenceKey)', () => {
    repo.upsertRecurring({
      id: 'r1', description: 'rent', amount: -3000, channel: 'bank',
      cadence: { kind: 'monthly', day: 1, monthEndPolicy: 'clamp' }, startDate: '2026-05-01',
    });
    repo.upsertLedger({
      id: 'e1', description: 'rent raised', amount: -3200, channel: 'bank',
      date: '2026-06-01', status: 'pending',
      recurringId: 'r1', occurrenceKey: 'r1@2026-06-01',
    });
    const list = repo.listLedger();
    expect(list[0]?.recurringId).toBe('r1');
    expect(list[0]?.occurrenceKey).toBe('r1@2026-06-01');
  });

  it('ledger: CHECK rejects mismatched recurringId/occurrenceKey', () => {
    expect(() =>
      repo.upsertLedger({
        id: 'bad', description: 'x', amount: -1, channel: 'bank',
        date: '2026-06-01', status: 'pending', recurringId: 'r1',
      }),
    ).toThrow();
  });

  it('recurring delete cascades to override rows (regression: ON DELETE SET NULL violated CHECK)', () => {
    repo.upsertRecurring({
      id: 'rent', description: 'rent', amount: -2000, channel: 'bank',
      cadence: { kind: 'monthly', day: 15, monthEndPolicy: 'clamp' }, startDate: '2026-05-01',
    });
    repo.upsertLedger({
      id: 'override-1', description: 'rent', amount: -2000, channel: 'bank',
      date: '2026-06-15', status: 'cleared',
      recurringId: 'rent', occurrenceKey: 'rent@2026-06-15',
    });
    expect(repo.listLedger()).toHaveLength(1);

    // Before the migration this threw because ON DELETE SET NULL would
    // null only recurring_id, violating CHECK ((recurring_id IS NULL) =
    // (occurrence_key IS NULL)).
    expect(() => repo.deleteRecurring('rent')).not.toThrow();
    expect(repo.listRecurring()).toEqual([]);
    expect(repo.listLedger()).toEqual([]);
  });

  it('settings: default + upsert', () => {
    const s = repo.getSettings();
    expect(s.threshold).toBe(2000);
    expect(s.timezone).toBe('Asia/Jerusalem');
    repo.upsertSettings({
      threshold: 5000, timezone: 'UTC', horizonMonths: 12, currency: 'ILS',
    });
    expect(repo.getSettings().threshold).toBe(5000);
    expect(repo.getSettings().horizonMonths).toBe(12);
  });

  it('migrations are idempotent', () => {
    // re-open the same DB path runs applyMigrations again
    const db = openDb({ path: ':memory:', migrationsDir });
    expect(() => new StateRepo(db).getAccount()).not.toThrow();
  });
});
