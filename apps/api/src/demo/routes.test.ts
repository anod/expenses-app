import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import express, { type Request, type Response, type NextFunction } from 'express';
import pino from 'pino';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDb } from '../db/openDb.js';
import { StateRepo } from '../db/stateRepo.js';
import { DemoController } from './demoController.js';
import { buildDemoRoutes } from './routes.js';

const here = dirname(fileURLToPath(import.meta.url));
const migrationsDir = resolve(here, '..', '..', 'migrations');
const silentLog = pino({ level: 'silent' });

let tmp: string;

const mkApp = (guard: 'on' | 'off') => {
  const db = openDb({ path: ':memory:', migrationsDir });
  const repo = new StateRepo(db);
  // DemoController persists state to demo-mode.json next to the DB path;
  // give each test its own tmp dir so test runs don't leak state.
  const controller = new DemoController(repo, join(tmp, 'expenses.db'), silentLog);
  const requireBearer = (req: Request, res: Response, next: NextFunction): void => {
    if (req.header('Authorization')?.startsWith('Bearer ')) {
      next();
      return;
    }
    res.status(401).json({ error: 'UNAUTHENTICATED' });
  };
  const app = express();
  app.use(express.json());
  app.use('/api', buildDemoRoutes(controller, guard === 'on' ? requireBearer : null));
  return { app, controller };
};

describe('demo routes auth gating', () => {
  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'demo-routes-'));
  });
  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  describe('with auth guard ON (REQUIRE_AUTH=true)', () => {
    let app: express.Express;
    let controller: DemoController;
    beforeEach(() => {
      ({ app, controller } = mkApp('on'));
    });

    it('GET /api/demo is public', async () => {
      const r = await request(app).get('/api/demo').expect(200);
      expect(r.body).toEqual({ enabled: false });
    });

    it('POST /api/demo enabled:true requires Bearer', async () => {
      await request(app).post('/api/demo').send({ enabled: true }).expect(401);
      expect(controller.isActive()).toBe(false);
    });

    it('POST /api/demo enabled:true succeeds with Bearer', async () => {
      await request(app)
        .post('/api/demo')
        .set('Authorization', 'Bearer fake')
        .send({ enabled: true })
        .expect(200);
      expect(controller.isActive()).toBe(true);
    });

    it('POST /api/demo enabled:false is always allowed (escape hatch from demo)', async () => {
      controller.setActive(true);
      const r = await request(app)
        .post('/api/demo')
        .send({ enabled: false })
        .expect(200);
      expect(r.body).toEqual({ enabled: false });
      expect(controller.isActive()).toBe(false);
    });

    it('POST /api/demo rejects malformed body', async () => {
      await request(app)
        .post('/api/demo')
        .set('Authorization', 'Bearer fake')
        .send({ enabled: 'yes' })
        .expect(400);
    });
  });

  describe('with auth guard OFF (REQUIRE_AUTH=false)', () => {
    it('POST /api/demo enabled:true is allowed unauthenticated', async () => {
      const { app, controller } = mkApp('off');
      await request(app).post('/api/demo').send({ enabled: true }).expect(200);
      expect(controller.isActive()).toBe(true);
    });
  });
});
