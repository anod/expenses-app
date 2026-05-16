import { existsSync, mkdirSync, readFileSync, writeFileSync, unlinkSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import type { Logger } from 'pino';
import { openDb } from '../db/openDb.js';
import { StateRepo } from '../db/stateRepo.js';
import { buildDemoState } from './seed.js';

/**
 * Runtime-toggleable demo mode.
 *
 * - Real repo: backed by the on-disk SQLite database (always opened).
 * - Demo repo: backed by an in-memory SQLite, seeded from buildDemoState()
 *   on first activation. Edits live in memory only; toggling off discards
 *   them and the next toggle-on gives a fresh seed.
 * - Active flag persists across server restarts in a small JSON file
 *   alongside the real DB. No DB migration required.
 */
export class DemoController {
  private readonly flagPath: string;
  private readonly realRepo: StateRepo;
  private demoRepo: StateRepo | null = null;
  private active: boolean;

  constructor(
    realRepo: StateRepo,
    realDbPath: string,
    private readonly log: Logger,
  ) {
    this.realRepo = realRepo;
    const dir = dirname(realDbPath);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    this.flagPath = resolve(dir, 'demo-mode.json');
    this.active = this.readFlag();
    if (this.active) {
      this.seedDemoRepo();
      this.log.warn('demo mode is ACTIVE on startup (persisted flag) — serving in-memory fake data');
    }
  }

  isActive(): boolean {
    return this.active;
  }

  getRepo(): StateRepo {
    if (this.active && this.demoRepo) return this.demoRepo;
    return this.realRepo;
  }

  setActive(enabled: boolean): boolean {
    if (enabled === this.active) return this.active;
    if (enabled) {
      this.seedDemoRepo();
      this.log.warn('demo mode ENABLED — serving in-memory fake data; real DB is untouched');
    } else {
      this.demoRepo = null;
      this.log.info('demo mode DISABLED — back to real DB');
    }
    this.active = enabled;
    this.writeFlag();
    return this.active;
  }

  private seedDemoRepo(): void {
    const demoDb = openDb({ path: ':memory:' });
    const repo = new StateRepo(demoDb);
    const demo = buildDemoState();
    repo.upsertAccount(demo.account);
    repo.upsertSettings(demo.settings);
    for (const c of demo.cards) repo.upsertCard(c);
    for (const r of demo.recurring) repo.upsertRecurring(r);
    for (const e of demo.ledger) repo.upsertLedger(e);
    this.demoRepo = repo;
  }

  private readFlag(): boolean {
    try {
      if (!existsSync(this.flagPath)) return false;
      const raw = readFileSync(this.flagPath, 'utf8');
      const parsed = JSON.parse(raw) as { enabled?: unknown };
      return parsed.enabled === true;
    } catch (err) {
      this.log.warn({ err }, 'failed to read demo-mode flag; defaulting to off');
      return false;
    }
  }

  private writeFlag(): void {
    try {
      if (this.active) {
        writeFileSync(this.flagPath, JSON.stringify({ enabled: true }, null, 2));
      } else if (existsSync(this.flagPath)) {
        unlinkSync(this.flagPath);
      }
    } catch (err) {
      this.log.error({ err }, 'failed to persist demo-mode flag');
    }
  }
}
