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
});
