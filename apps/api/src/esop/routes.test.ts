import express from 'express';
import request from 'supertest';
import { describe, expect, it, vi } from 'vitest';
import { buildEsopRoutes } from './routes.js';
import type { GraphEsopReader } from './graphEsopReader.js';

vi.mock('./marketData.js', () => ({
  fetchYahooQuote: vi.fn(async (symbol: string) => ({
    symbol,
    price: symbol === 'USDILS=X' ? 3.6 : 440,
    currency: symbol === 'USDILS=X' ? 'ILS' : 'USD',
    fetchedAt: '2026-05-22T00:00:00.000Z',
  })),
}));

function mkApp(isDemo: () => boolean, reader: GraphEsopReader | null = null) {
  const app = express();
  app.use(express.json());
  app.use('/api', buildEsopRoutes(reader, isDemo));
  return app;
}

describe('ESOP routes', () => {
  it('serves demo ESOP data without Graph configuration or token', async () => {
    const res = await request(mkApp(() => true)).get('/api/esop').expect(200);

    expect(res.body.grants).toHaveLength(3);
    expect(res.body.assumptions.currentPriceUsd).toBe(430);
    expect(res.body.totals.netNis).toBeGreaterThan(0);
  });

  it('serves demo ESOP status without Graph configuration or token', async () => {
    const res = await request(mkApp(() => true)).get('/api/esop/status').expect(200);

    expect(res.body.source).toBe('demo');
    expect(res.body.workbook).toMatchObject({ name: 'Demo ESOP workbook', worksheet: 'ESOP' });
  });

  it('simulates market updates in demo mode without a Graph token', async () => {
    const res = await request(mkApp(() => true))
      .post('/api/esop/market/update')
      .send({ stockSymbol: 'MSFT', fxSymbol: 'USDILS=X', asOf: '2026-05-22' })
      .expect(200);

    expect(res.body.applied).toEqual({ usdNisRate: 3.6, currentPriceUsd: 440 });
    expect(res.body.esop.assumptions).toMatchObject({
      usdNisRate: 3.6,
      currentPriceUsd: 440,
      asOf: '2026-05-22',
    });
  });

  it('still requires Graph configuration when demo mode is off', async () => {
    const res = await request(mkApp(() => false)).get('/api/esop').expect(501);

    expect(res.body.error).toBe('ESOP_NOT_CONFIGURED');
  });
});
