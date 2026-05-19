import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
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

const ALLOWED_ORIGIN = 'http://localhost:4200';

let tmp: string;

const mkApp = () => {
  const db = openDb({ path: ':memory:', migrationsDir });
  const repo = new StateRepo(db);
  // DemoController persists state to demo-mode.json next to the DB path;
  // give each test its own tmp dir so test runs don't leak state.
  const controller = new DemoController(repo, join(tmp, 'expenses.db'), silentLog);
  const app = express();
  app.use(express.json());
  app.use('/api', buildDemoRoutes(controller, ALLOWED_ORIGIN));
  return { app, controller };
};

describe('demo routes', () => {
  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'demo-routes-'));
  });
  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it('GET /api/demo is public', async () => {
    const { app } = mkApp();
    const r = await request(app).get('/api/demo').expect(200);
    expect(r.body).toEqual({ enabled: false });
  });

  it('POST /api/demo enabled:true is allowed without auth (sign-in landing flow)', async () => {
    const { app, controller } = mkApp();
    await request(app).post('/api/demo').send({ enabled: true }).expect(200);
    expect(controller.isActive()).toBe(true);
  });

  it('POST /api/demo enabled:false is always allowed (escape hatch from demo)', async () => {
    const { app, controller } = mkApp();
    controller.setActive(true);
    const r = await request(app).post('/api/demo').send({ enabled: false }).expect(200);
    expect(r.body).toEqual({ enabled: false });
    expect(controller.isActive()).toBe(false);
  });

  it('POST /api/demo rejects malformed body', async () => {
    const { app } = mkApp();
    await request(app).post('/api/demo').send({ enabled: 'yes' }).expect(400);
  });

  describe('CSRF / origin gate', () => {
    it('rejects POST with a mismatched Origin header', async () => {
      const { app, controller } = mkApp();
      await request(app)
        .post('/api/demo')
        .set('Origin', 'http://evil.example')
        .send({ enabled: true })
        .expect(403);
      expect(controller.isActive()).toBe(false);
    });

    it('rejects POST with a mismatched Referer header', async () => {
      const { app, controller } = mkApp();
      await request(app)
        .post('/api/demo')
        .set('Referer', 'http://evil.example/foo')
        .send({ enabled: true })
        .expect(403);
      expect(controller.isActive()).toBe(false);
    });

    it('accepts POST with matching Origin', async () => {
      const { app, controller } = mkApp();
      await request(app)
        .post('/api/demo')
        .set('Origin', ALLOWED_ORIGIN)
        .send({ enabled: true })
        .expect(200);
      expect(controller.isActive()).toBe(true);
    });

    it('accepts POST with matching Referer prefix', async () => {
      const { app, controller } = mkApp();
      await request(app)
        .post('/api/demo')
        .set('Referer', `${ALLOWED_ORIGIN}/login`)
        .send({ enabled: true })
        .expect(200);
      expect(controller.isActive()).toBe(true);
    });

    it('allows POST without any Origin/Referer (non-browser clients)', async () => {
      const { app, controller } = mkApp();
      await request(app).post('/api/demo').send({ enabled: true }).expect(200);
      expect(controller.isActive()).toBe(true);
    });
  });
});
