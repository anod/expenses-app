import { readFileSync, readdirSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import Database, { type Database as Db } from 'better-sqlite3';

const here = dirname(fileURLToPath(import.meta.url));
const defaultMigrationsDir = resolve(here, '..', '..', 'migrations');

export interface OpenDbOptions {
  /** Absolute path or `:memory:`. */
  path: string;
  /** Override the migrations directory (mostly for tests). */
  migrationsDir?: string;
}

export const openDb = ({ path, migrationsDir: mdir }: OpenDbOptions): Db => {
  if (path !== ':memory:') {
    mkdirSync(dirname(path), { recursive: true });
  }
  const db = new Database(path);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  applyMigrations(db, mdir ?? defaultMigrationsDir);
  return db;
};

export const applyMigrations = (db: Db, dir: string): void => {
  db.exec(
    'CREATE TABLE IF NOT EXISTS schema_migrations (' +
    'version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)',
  );
  const applied = new Set<number>(
    db
      .prepare<[], { version: number }>('SELECT version FROM schema_migrations')
      .all()
      .map((r) => r.version),
  );
  const files = readdirSync(dir)
    .filter((f) => /^\d+-.*\.sql$/.test(f))
    .sort();
  const insert = db.prepare(
    'INSERT INTO schema_migrations(version, applied_at) VALUES (?, ?)',
  );
  for (const file of files) {
    const version = Number(file.split('-', 1)[0]);
    if (applied.has(version)) continue;
    const sql = readFileSync(join(dir, file), 'utf8');
    db.transaction(() => {
      db.exec(sql);
      insert.run(version, new Date().toISOString());
    })();
  }
};
