/**
 * Online backup of the SQLite DB using better-sqlite3's `db.backup()`.
 * Writes to `${DB_PATH%/*.db}/backups/expenses-YYYY-MM-DDTHH-mm-ss.db` and
 * keeps the most recent N (default 14). Safe to run while the API is
 * serving — SQLite handles concurrent reads.
 *
 * Schedule on the host:
 *   0 3 * * * docker exec expenses node /app/apps/api/dist/scripts/backup-db.js
 */
import { mkdirSync, readdirSync, statSync, unlinkSync } from 'node:fs';
import { dirname, join } from 'node:path';
import Database from 'better-sqlite3';

const dbPath = process.env.DB_PATH ?? '/data/expenses.db';
const retention = Math.max(1, Number(process.env.BACKUP_RETENTION ?? 14));
const backupDir = process.env.BACKUP_DIR ?? join(dirname(dbPath), 'backups');

function timestamp(): string {
  const d = new Date();
  const pad = (n: number) => (n < 10 ? `0${n}` : String(n));
  return (
    `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}` +
    `T${pad(d.getUTCHours())}-${pad(d.getUTCMinutes())}-${pad(d.getUTCSeconds())}Z`
  );
}

async function main(): Promise<void> {
  mkdirSync(backupDir, { recursive: true });
  const out = join(backupDir, `expenses-${timestamp()}.db`);

  const db = new Database(dbPath, { readonly: true, fileMustExist: true });
  try {
    await db.backup(out);
  } finally {
    db.close();
  }

  const size = statSync(out).size;
  console.log(`backup: wrote ${out} (${size} bytes)`);

  const existing = readdirSync(backupDir)
    .filter((f) => /^expenses-.*\.db$/.test(f))
    .map((f) => ({ f, mtime: statSync(join(backupDir, f)).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime);
  const toDelete = existing.slice(retention);
  for (const { f } of toDelete) {
    unlinkSync(join(backupDir, f));
    console.log(`backup: pruned ${f}`);
  }
  console.log(`backup: kept ${existing.length - toDelete.length} of ${existing.length} files`);
}

main().catch((err) => {
  console.error('backup failed:', err);
  process.exit(1);
});
