import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';
import { openDb } from '../db/openDb.js';
import { StateRepo } from '../db/stateRepo.js';
import { buildForecastRoutes } from './routes.js';

const here = dirname(fileURLToPath(import.meta.url));
const migrationsDir = resolve(here, '..', '..', 'migrations');

const TODAY = new Date().toISOString().slice(0, 10);

const mkApp = () => {
  const db = openDb({ path: ':memory:', migrationsDir });
  const repo = new StateRepo(db);
  const app = express();
  app.use(express.json());
  app.use('/api', buildForecastRoutes(() => repo));
  return { app, repo };
};

describe('forecast routes', () => {
  let app: express.Express;
  let repo: StateRepo;

  beforeEach(() => {
    ({ app, repo } = mkApp());
  });

  it('GET /api/forecast returns days+status with empty DB', async () => {
    const r = await request(app).get('/api/forecast').expect(200);
    expect(Array.isArray(r.body.days)).toBe(true);
    expect(r.body.status).toBe('breach');
  });

  it('PATCH /api/account updates and returns fresh forecast', async () => {
    const r = await request(app)
      .patch('/api/account')
      .send({ bankBalance: 10_000, asOf: TODAY })
      .expect(200);
    expect(r.body.entity.bankBalance).toBe(10_000);
    expect(r.body.forecast.days[0].balance).toBe(10_000);
  });

  it('PATCH /api/account rejects future asOf', async () => {
    await request(app)
      .patch('/api/account')
      .send({ bankBalance: 1000, asOf: '2099-01-01' })
      .expect(400);
  });

  it('PATCH /api/account 400 on invalid body', async () => {
    await request(app)
      .patch('/api/account')
      .send({ bankBalance: 'not a number', asOf: TODAY })
      .expect(400);
  });

  it('POST/PATCH/DELETE /api/cards lifecycle', async () => {
    const created = await request(app)
      .post('/api/cards')
      .send({ name: 'Visa', currentDebit: 0, asOf: TODAY, billingDayOfMonth: 2 })
      .expect(200);
    const id = created.body.entity.id;
    expect(id).toBeTruthy();

    await request(app)
      .patch(`/api/cards/${id}`)
      .send({ name: 'Visa', currentDebit: 500, asOf: TODAY, billingDayOfMonth: 2 })
      .expect(200);
    expect(repo.listCards()[0]?.currentDebit).toBe(500);

    await request(app).delete(`/api/cards/${id}`).expect(200);
    expect(repo.listCards()).toEqual([]);
  });

  it('POST /api/cards 400 on invalid billing day', async () => {
    await request(app)
      .post('/api/cards')
      .send({ name: 'X', currentDebit: 0, asOf: TODAY, billingDayOfMonth: 32 })
      .expect(400);
  });

  it('POST /api/ledger creates entry and reflects in forecast', async () => {
    await request(app)
      .patch('/api/account').send({ bankBalance: 10_000, asOf: TODAY }).expect(200);
    const r = await request(app)
      .post('/api/ledger')
      .send({
        description: 'mortgage', amount: -5500, channel: 'bank',
        date: '2026-06-10', status: 'pending',
      })
      .expect(200);
    const day = r.body.forecast.days.find((d: { date: string }) => d.date === '2026-06-10');
    expect(day.delta).toBe(-5500);
  });

  it('POST /api/ledger rejects mismatched recurringId/occurrenceKey', async () => {
    await request(app)
      .post('/api/ledger')
      .send({
        description: 'x', amount: -10, channel: 'bank',
        date: '2026-06-10', recurringId: 'r1',
      })
      .expect(400);
  });

  it('POST /api/ledger/:id/clear marks cleared and removes from forecast', async () => {
    await request(app).patch('/api/account').send({ bankBalance: 10_000, asOf: TODAY });
    const created = await request(app)
      .post('/api/ledger')
      .send({
        description: 'lunch', amount: -50, channel: 'bank',
        date: '2026-06-10', status: 'pending',
      });
    const id = created.body.entity.id;
    const r = await request(app).post(`/api/ledger/${id}/clear`).expect(200);
    expect(r.body.entity.status).toBe('cleared');
    const day = r.body.forecast.days.find((d: { date: string }) => d.date === '2026-06-10');
    expect(day.delta).toBe(0);
  });

  it('POST /api/ledger/:id/clear 404 on unknown id', async () => {
    await request(app).post('/api/ledger/does-not-exist/clear').expect(404);
  });

  it('POST /api/ledger/:id/clear materializes override for VIRTUAL recurring occurrence', async () => {
    // Reproduces a real bug: the timeline shows virtual recurring entries
    // with ids `virtual:<templateId>:<date>`, but the clear handler used to
    // only search persisted rows → silent 404 on the most common case.
    await request(app)
      .patch('/api/account').send({ bankBalance: 10_000, asOf: '2026-05-01' }).expect(200);
    const tpl = await request(app)
      .post('/api/recurring')
      .send({
        description: 'rent', amount: -2000, channel: 'bank',
        day: 15, startDate: '2026-05-01',
      })
      .expect(200);
    const recurringId = tpl.body.entity.id;

    const fc = await request(app).get('/api/forecast').expect(200);
    // Sanity: forecast has charges on Jun 15 from the virtual recurring.
    const jun15Before = fc.body.days.find((d: { date: string }) => d.date === '2026-06-15');
    expect(jun15Before.delta).toBe(-2000);

    const cleared = await request(app)
      .post(`/api/ledger/virtual:${recurringId}:2026-06-15/clear`)
      .expect(200);
    expect(cleared.body.entity.status).toBe('cleared');
    expect(cleared.body.entity.recurringId).toBe(recurringId);
    expect(cleared.body.entity.occurrenceKey).toBe(`${recurringId}@2026-06-15`);

    // After clearing, the Jun 15 occurrence must be gone but Jul 15 stays.
    const after = cleared.body.forecast.days;
    const jun15 = after.find((d: { date: string }) => d.date === '2026-06-15');
    const jul15 = after.find((d: { date: string }) => d.date === '2026-07-15');
    expect(jun15.delta).toBe(0);
    expect(jul15.delta).toBe(-2000);

    // The cleared row is now persisted (so it survives re-import).
    const persisted = repo.listLedger();
    expect(persisted).toHaveLength(1);
    expect(persisted[0]!.status).toBe('cleared');
    expect(persisted[0]!.occurrenceKey).toBe(`${recurringId}@2026-06-15`);
  });

  it('POST /api/ledger/:id/clear 404 when virtual references unknown template', async () => {
    await request(app)
      .post('/api/ledger/virtual:missing-id:2026-06-15/clear')
      .expect(404);
  });

  it('POST/PATCH/DELETE /api/recurring lifecycle', async () => {
    const r = await request(app)
      .post('/api/recurring')
      .send({
        description: 'salary', amount: 15_000, channel: 'bank',
        day: 1, startDate: '2026-05-01',
      })
      .expect(200);
    const id = r.body.entity.id;
    expect(id).toBeTruthy();

    await request(app)
      .patch(`/api/recurring/${id}`)
      .send({
        description: 'salary v2', amount: 16_000, channel: 'bank',
        day: 1, startDate: '2026-05-01',
      })
      .expect(200);
    expect(repo.listRecurring()[0]?.amount).toBe(16_000);

    await request(app).delete(`/api/recurring/${id}`).expect(200);
    expect(repo.listRecurring()).toEqual([]);
  });

  it('PATCH /api/settings updates threshold', async () => {
    const r = await request(app)
      .patch('/api/settings')
      .send({ threshold: 5000, timezone: 'Asia/Jerusalem', horizonMonths: 3, currency: 'ILS' })
      .expect(200);
    expect(r.body.entity.threshold).toBe(5000);
    expect(r.body.entity.horizonMonths).toBe(3);
  });

  describe('recurring (weekly + skips)', () => {
    it('POST /api/recurring accepts the new cadence shape (weekly)', async () => {
      const r = await request(app)
        .post('/api/recurring')
        .send({
          description: 'therapy',
          amount: -205,
          channel: 'bank',
          cadence: { kind: 'weekly', dayOfWeek: 5 },
          startDate: '2026-06-05',
        })
        .expect(200);
      expect(r.body.entity.cadence).toEqual({ kind: 'weekly', dayOfWeek: 5 });
    });

    it('POST /api/recurring 400 when neither cadence nor day provided', async () => {
      await request(app)
        .post('/api/recurring')
        .send({
          description: 'x', amount: -10, channel: 'bank', startDate: '2026-06-05',
        })
        .expect(400);
    });

    it('POST /api/recurring/:id/skips/:date adds a skip', async () => {
      const c = await request(app)
        .post('/api/recurring')
        .send({
          description: 'therapy', amount: -205, channel: 'bank',
          cadence: { kind: 'weekly', dayOfWeek: 5 }, startDate: '2026-06-05',
        })
        .expect(200);
      const id = c.body.entity.id as string;
      const r = await request(app)
        .post(`/api/recurring/${id}/skips/2026-06-12`)
        .expect(200);
      expect(r.body.entity.skips).toContain('2026-06-12');
    });

    it('POST /skips/:date drops a pending persisted override', async () => {
      repo.upsertRecurring({
        id: 'therapy', description: 'therapy', amount: -205, channel: 'bank',
        cadence: { kind: 'weekly', dayOfWeek: 5 }, startDate: '2026-06-05',
      });
      repo.upsertLedger({
        id: 'ov', description: 'therapy (bumped)', amount: -250, channel: 'bank',
        date: '2026-06-12', status: 'pending',
        recurringId: 'therapy', occurrenceKey: 'therapy@2026-06-12',
      });
      await request(app)
        .post('/api/recurring/therapy/skips/2026-06-12')
        .expect(200);
      expect(repo.listLedger()).toEqual([]);
      expect(repo.listRecurring()[0]!.skips).toContain('2026-06-12');
    });

    it('POST /skips/:date 409 SKIP_CONFLICT_CLEARED when override is cleared', async () => {
      repo.upsertRecurring({
        id: 'therapy', description: 'therapy', amount: -205, channel: 'bank',
        cadence: { kind: 'weekly', dayOfWeek: 5 }, startDate: '2026-06-05',
      });
      repo.upsertLedger({
        id: 'ov', description: 'therapy', amount: -205, channel: 'bank',
        date: '2026-06-12', status: 'cleared',
        recurringId: 'therapy', occurrenceKey: 'therapy@2026-06-12',
      });
      const r = await request(app)
        .post('/api/recurring/therapy/skips/2026-06-12')
        .expect(409);
      expect(r.body.error).toBe('SKIP_CONFLICT_CLEARED');
      // No skip was recorded; override stays.
      expect(repo.listRecurring()[0]!.skips).toBeUndefined();
      expect(repo.listLedger()).toHaveLength(1);
    });

    it('POST /skips/:date 400 on bad date, 404 on unknown template', async () => {
      await request(app).post('/api/recurring/x/skips/not-a-date').expect(400);
      await request(app).post('/api/recurring/missing/skips/2026-06-12').expect(404);
    });

    it('DELETE /skips/:date removes a skip', async () => {
      repo.upsertRecurring({
        id: 'therapy', description: 'therapy', amount: -205, channel: 'bank',
        cadence: { kind: 'weekly', dayOfWeek: 5 }, startDate: '2026-06-05',
      });
      repo.addSkip('therapy', '2026-06-12');
      const r = await request(app)
        .delete('/api/recurring/therapy/skips/2026-06-12')
        .expect(200);
      expect(r.body.entity.skips).toBeUndefined();
    });
  });
});
