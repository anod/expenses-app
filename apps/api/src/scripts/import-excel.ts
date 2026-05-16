/**
 * Excel → SQLite importer CLI.
 *
 * Reads the latest workbook dump under `dumps/`, parses it via
 * `parseWorkbookDump`, and delegates the actual write to the shared
 * `importFromSnapshot` module (used by both this CLI and the
 * POST /api/import/excel endpoint).
 *
 * Privacy: never prints financial values to stdout. Writes a parity
 * report (gitignored) to the active session-state files dir.
 */
import { readFileSync, readdirSync, writeFileSync, mkdirSync, existsSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  parseWorkbookDump,
  type ForecastResult,
  type WorkbookSnapshot,
} from '@expenses/shared';
import { loadConfig } from '../config.js';
import { openDb } from '../db/openDb.js';
import { StateRepo } from '../db/stateRepo.js';
import { computeForecast } from '../forecast/computeForecast.js';
import {
  importFromSnapshot,
  type ImportSummary,
} from '../import/importFromSnapshot.js';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..', '..', '..', '..');

const findLatestDump = (): string => {
  const dumpsDir = join(repoRoot, 'dumps');
  if (!existsSync(dumpsDir)) {
    throw new Error(`No dumps directory at ${dumpsDir}`);
  }
  const file = readdirSync(dumpsDir)
    .filter((f) => f.startsWith('dump-') && f.endsWith('.json'))
    .sort()
    .at(-1);
  if (!file) throw new Error('No dump-*.json file found under dumps/');
  return join(dumpsDir, file);
};

const sessionFilesDir = (): string | null => {
  const home = process.env.HOME ?? process.env.USERPROFILE;
  if (!home) return null;
  const root = join(home, '.copilot', 'session-state');
  if (!existsSync(root)) return null;
  const sessions = readdirSync(root).filter((f) => /^[0-9a-f-]{36}$/.test(f));
  if (sessions.length === 0) return null;
  sessions.sort((a, b) => statSync(join(root, a)).mtimeMs - statSync(join(root, b)).mtimeMs);
  return join(root, sessions.at(-1)!, 'files');
};

const writeParityReport = (
  repo: StateRepo,
  snap: WorkbookSnapshot,
  summary: ImportSummary,
): void => {
  const forecast: ForecastResult = computeForecast(repo);
  const lines: string[] = [];
  lines.push('# Excel parity — import', '');
  lines.push(`- Workbook: \`${summary.workbook}\` / \`${summary.worksheet}\``);
  lines.push(`- Months parsed: ${summary.monthsParsed}`);
  lines.push(`- account.asOf: ${summary.startDate}`);
  lines.push(`- Credit cards created: ${summary.cardsCreated}`);
  lines.push(`- Recurring templates created: ${summary.recurringCreated}`);
  lines.push(`- Ledger entries created: ${summary.ledgerCreated}`);
  lines.push('');

  lines.push('## Anchor balance: Excel vs Forecast', '');
  lines.push('| Anchor date | Excel balance | Forecast balance | Diff |');
  lines.push('| --- | ---: | ---: | ---: |');
  for (const m of snap.months) {
    const excel = snap.balanceRow?.amounts?.[m.key]?.value ?? null;
    const day = forecast.days.find((d) => d.date === m.key);
    const f = day?.balance ?? null;
    const diff = f != null && excel != null ? f - excel : null;
    lines.push(
      `| ${m.key} | ${excel == null ? '—' : excel.toFixed(2)} | ` +
      `${f == null ? '—' : f.toFixed(2)} | ` +
      `${diff == null ? '—' : diff.toFixed(2)} |`,
    );
  }
  lines.push('');
  lines.push(
    `Forecast min: ${forecast.minBalance.toFixed(2)} on ${forecast.minBalanceDate} — status **${forecast.status}**`,
  );

  const dir = sessionFilesDir();
  if (dir) {
    mkdirSync(dir, { recursive: true });
    const out = join(dir, 'parity-wave-2d.md');
    writeFileSync(out, lines.join('\n'));
    console.log(`Parity report: ${out}`);
  } else {
    const fallback = join(repoRoot, 'scripts', 'output', 'parity-wave-2d.md');
    mkdirSync(dirname(fallback), { recursive: true });
    writeFileSync(fallback, lines.join('\n'));
    console.log(`Parity report: ${fallback}`);
  }
};

const main = async (): Promise<void> => {
  const dumpPath = findLatestDump();
  const dump = JSON.parse(readFileSync(dumpPath, 'utf8')) as unknown;
  const snap = parseWorkbookDump(dump as never);

  const config = loadConfig({
    ...process.env,
    EXPENSES_SOURCE: process.env.EXPENSES_SOURCE ?? 'dump',
  });
  const dbPath = resolve(repoRoot, config.DB_PATH);
  const db = openDb({ path: dbPath });
  const repo = new StateRepo(db);

  // CLI mode: reset Settings to defaults (matches historical behavior).
  const summary = importFromSnapshot(repo, snap, { preserveSettings: false });
  writeParityReport(repo, snap, summary);
  db.close();

  console.log('Excel → SQLite import complete:');
  console.log(`  workbook:          ${summary.workbook} / ${summary.worksheet}`);
  console.log(`  months parsed:     ${summary.monthsParsed}`);
  console.log(`  account.asOf:      ${summary.startDate}`);
  console.log(`  credit cards:      ${summary.cardsCreated}`);
  console.log(`  recurring created: ${summary.recurringCreated}`);
  console.log(`  ledger created:    ${summary.ledgerCreated}`);
  console.log(`  skipped rows:      ${summary.skippedRows.length}`);
  for (const s of summary.skippedRows) {
    console.log(`    - "${s.label}" — ${s.reason}`);
  }
};

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
