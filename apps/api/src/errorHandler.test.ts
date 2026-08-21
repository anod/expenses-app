import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import express, { type Request, type Response, type NextFunction } from 'express';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { openDb } from './db/openDb.js';
import { StateRepo } from './db/stateRepo.js';
import { buildForecastRoutes } from './forecast/routes.js';
import { errorHandler } from './errorHandler.js';

const here = dirname(fileURLToPath(import.meta.url));
const migrationsDir = resolve(here, '..', 'migrations');

const noopLog = {
  warn: () => {},
  error: () => {},
  info: () => {},
  debug: () => {},
};

/**
 * Attaches the `req.log` that `pino-http` provides in the real server.
 *
 * `Request.log` is declared as a full pino `Logger`, so the stub is widened
 * through `unknown` rather than implementing every member of that interface.
 */
const withLog = (req: Request, _res: Response, next: NextFunction) => {
  (req as unknown as { log: typeof noopLog }).log = noopLog;
  next();
};

const mkApp = (mount: (app: express.Express) => void) => {
  const app = express();
  app.use(withLog);
  app.use(express.json());
  mount(app);
  app.use(errorHandler);
  return app;
};

describe('errorHandler', () => {
  it('maps a thrown 4xx-tagged error to that status, not 500', async () => {
    const app = mkApp((a) =>
      a.get('/boom', () => {
        const err = new Error('savings pot asOf must not be in the future');
        (err as Error & { status?: number }).status = 400;
        throw err;
      }),
    );

    const res = await request(app).get('/boom');
    expect(res.status).toBe(400);
    expect(res.body.message).toContain('must not be in the future');
  });

  it('honours statusCode as well as status', async () => {
    const app = mkApp((a) =>
      a.get('/boom', () => {
        const err = new Error('nope');
        (err as Error & { statusCode?: number }).statusCode = 409;
        throw err;
      }),
    );

    expect((await request(app).get('/boom')).status).toBe(409);
  });

  it('still reports untagged failures as 500', async () => {
    const app = mkApp((a) =>
      a.get('/boom', () => {
        throw new Error('genuinely broken');
      }),
    );

    const res = await request(app).get('/boom');
    expect(res.status).toBe(500);
    expect(res.body.error).toBe('INTERNAL_ERROR');
  });

  it('does not treat a 5xx-tagged error as a client error', async () => {
    const app = mkApp((a) =>
      a.get('/boom', () => {
        const err = new Error('upstream exploded');
        (err as Error & { status?: number }).status = 503;
        throw err;
      }),
    );

    expect((await request(app).get('/boom')).status).toBe(500);
  });

  it('turns a malformed JSON body into 400 rather than 500', async () => {
    const app = mkApp((a) => a.post('/echo', (_req, res) => res.json({ ok: true })));

    const res = await request(app)
      .post('/echo')
      .set('content-type', 'application/json')
      .send('{"broken":');
    expect(res.status).toBe(400);
  });

  // The regression that motivated extracting this handler: the route guards
  // tag their errors with `status = 400`, but the server's fallback branch
  // used to ignore that and report 500 INTERNAL_ERROR.
  describe('mounted with the real forecast routes', () => {
    const mkForecastApp = () => {
      const db = openDb({ path: ':memory:', migrationsDir });
      const repo = new StateRepo(db);
      return mkApp((a) => a.use('/api', buildForecastRoutes(() => repo)));
    };

    it('returns 400 for a recurring template on an unknown pot', async () => {
      const res = await request(mkForecastApp())
        .post('/api/recurring')
        .send({
          description: 'Bogus',
          amount: -100,
          channel: 'savings:does-not-exist',
          startDate: '2026-01-10',
          cadence: { kind: 'monthly', day: 10 },
        });

      expect(res.status).toBe(400);
      expect(res.body.message).toContain('unknown savings pot');
    });

    it('returns 400 for a ledger entry on an unknown pot', async () => {
      const res = await request(mkForecastApp())
        .post('/api/ledger')
        .send({
          description: 'Bogus',
          amount: -100,
          channel: 'savings:does-not-exist',
          date: '2026-01-10',
        });

      expect(res.status).toBe(400);
    });

    it('returns 400 for a pot snapshot dated in the future', async () => {
      const res = await request(mkForecastApp())
        .post('/api/pots')
        .send({ name: 'Future', balance: 0, asOf: '2099-01-01' });

      expect(res.status).toBe(400);
      expect(res.body.message).toContain('must not be in the future');
    });
  });
});
