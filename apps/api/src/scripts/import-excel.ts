/**
 * Excel → SQLite importer.
 *
 * Reads the latest workbook dump under `dumps/`, parses it via
 * `parseWorkbookDump`, and seeds the configured SQLite DB with:
 *   - account                = bank balance at the first month's anchor.
 *   - settings               = defaults (₪2,000 threshold, Asia/Jerusalem, ILS).
 *   - credit_card            = one per recognised cc source.
 *   - recurring_template     = rows that repeat the same amount across all
 *                              non-null months (with day != null).
 *   - ledger_entry           = (a) per-month values for variable rows;
 *                              (b) per-period card-bill rows derived from
 *                                  «карта потрачено» beyond the first month;
 *                              (c) per-period «карта остаток» placeholder.
 *
 * Stable IDs (Wave 2f foundation):
 *  - Excel-sourced rows are written with deterministic IDs prefixed `excel:`
 *    so re-runs are idempotent without wholesale truncation.
 *  - User-created entries (assigned non-`excel:` IDs by the API) are NOT
 *    touched by re-imports — they survive across runs.
 *  - On re-import we delete only `excel:*` rows that are no longer in the
 *    workbook, and preserve `status='cleared'` for already-cleared imported
 *    ledger entries (user's clear action wins over Excel re-import).
 *
 * Excel period-bucket semantics: each column header (e.g. "2026-05") is an
 * anchor date; values in that column represent bank deltas in the period
 * (col-anchor, col-anchor+1m]. `scheduleDateForColumn` maps (column, day)
 * into that period; day-null rows default to the next anchor day.
 *
 * Privacy: this script never prints financial values to stdout. It writes
 * a parity report (gitignored) to the active session-state files dir; that
 * report contains real numbers and must stay local.
 */
import { readFileSync, readdirSync, writeFileSync, mkdirSync, existsSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  parseWorkbookDump,
  type ExpenseRow,
  type ForecastResult,
  type LedgerEntry,
  type RecurringTemplate,
  type CreditCard,
} from '@expenses/shared';
import { loadConfig } from '../config.js';
import { openDb } from '../db/openDb.js';
import { StateRepo } from '../db/stateRepo.js';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..', '..', '..', '..');

/**
 * Workbook `source` values that represent credit cards (will be modelled
 * as separate CreditCard entities with cc-routing through the pipeline).
 * Other non-empty sources (e.g. 'onezero' = OneZero digital bank) are
 * treated as bank-channel direct charges, with the source kept as a
 * description prefix.
 */
const CREDIT_CARD_SOURCES: Record<string, { name: string; billingDay: number }> = {
  cal: { name: 'Cal', billingDay: 2 },
  isra: { name: 'Isracard', billingDay: 2 },
};

interface ImportSummary {
  workbook: string;
  worksheet: string;
  monthsParsed: number;
  startDate: string;
  startBalance: number;
  cardsCreated: number;
  recurringCreated: number;
  ledgerCreated: number;
  warnings: string[];
  skippedRows: { label: string; reason: string }[];
}

const skipLabels = new Set(['карта потрачено']);

const pad = (n: number): string => (n < 10 ? `0${n}` : String(n));

const daysInMonth = (year: number, month: number): number =>
  new Date(year, month, 0).getDate();

const clampedDate = (monthKey: string, day: number): string => {
  const [yStr, mStr] = monthKey.split('-');
  const year = Number(yStr);
  const month = Number(mStr);
  const clamped = Math.min(day, daysInMonth(year, month));
  return `${yStr}-${mStr}-${pad(clamped)}`;
};

const describe = (row: ExpenseRow): string =>
  row.source ? `[${row.source}] ${row.labelTrimmed}` : row.labelTrimmed;

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

const partitionRows = (
  rows: ExpenseRow[],
  monthKeys: string[],
): {
  recurringRows: ExpenseRow[];
  variableRows: ExpenseRow[];
  skipped: { label: string; reason: string }[];
} => {
  const recurringRows: ExpenseRow[] = [];
  const variableRows: ExpenseRow[] = [];
  const skipped: { label: string; reason: string }[] = [];

  for (const row of rows) {
    if (row.kind === 'derived' && row.labelTrimmed !== 'карта остаток') {
      skipped.push({ label: row.labelTrimmed, reason: 'derived row' });
      continue;
    }
    if (skipLabels.has(row.labelTrimmed)) {
      skipped.push({
        label: row.labelTrimmed,
        reason: 'workbook book-keeping row',
      });
      continue;
    }
    const nonNullValues = monthKeys
      .map((k) => row.amounts[k]?.value)
      .filter((v): v is number => typeof v === 'number');

    if (nonNullValues.length === 0) {
      skipped.push({ label: row.labelTrimmed, reason: 'no values in any month' });
      continue;
    }
    const allZero = nonNullValues.every((v) => v === 0);
    if (allZero) {
      skipped.push({ label: row.labelTrimmed, reason: 'all values zero' });
      continue;
    }
    const allEqual = nonNullValues.every((v) => v === nonNullValues[0]);
    const presentEveryMonth = monthKeys.every(
      (k) => typeof row.amounts[k]?.value === 'number',
    );
    // Recurring requires a day-of-month (cadence anchor). Day-null rows fall
    // through to the variable path which schedules per-column.
    if (row.day != null && allEqual && nonNullValues.length >= 2 && presentEveryMonth) {
      recurringRows.push(row);
    } else {
      variableRows.push(row);
    }
  }

  return { recurringRows, variableRows, skipped };
};

const sanitizeId = (s: string): string =>
  s
    .normalize('NFKD')
    .replace(/[^a-zA-Z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .toLowerCase()
    .slice(0, 32) || 'row';

/** Stable-ID prefix that marks a row as Excel-sourced. */
const EXCEL_PREFIX = 'excel:';

const sourceKey = (s: string): string => (s.trim() || '_').toLowerCase();

const excelRecurringId = (row: ExpenseRow): string =>
  `${EXCEL_PREFIX}r:${sourceKey(row.source)}:${sanitizeId(row.labelTrimmed)}:${row.day ?? 'x'}`;

const excelLedgerId = (row: ExpenseRow, monthKey: string): string =>
  `${EXCEL_PREFIX}l:${sourceKey(row.source)}:${sanitizeId(row.labelTrimmed)}:${monthKey.slice(0, 7)}`;

const excelCardBillId = (cardId: string, monthKey: string): string =>
  `${EXCEL_PREFIX}l:cardbill:${cardId}:${monthKey.slice(0, 7)}`;

const sessionFilesDir = (): string | null => {
  const home = process.env.HOME ?? process.env.USERPROFILE;
  if (!home) return null;
  const root = join(home, '.copilot', 'session-state');
  if (!existsSync(root)) return null;
  const sessions = readdirSync(root).filter((f) => /^[0-9a-f-]{36}$/.test(f));
  if (sessions.length === 0) return null;
  // Pick session whose directory was modified most recently.
  sessions.sort((a, b) => {
    const sa = statSync(join(root, a)).mtimeMs;
    const sb = statSync(join(root, b)).mtimeMs;
    return sa - sb;
  });
  return join(root, sessions.at(-1)!, 'files');
};

import { computeForecast } from '../forecast/computeForecast.js';

const writeParityReport = async (
  repo: StateRepo,
  snap: ReturnType<typeof parseWorkbookDump>,
  summary: ImportSummary,
): Promise<void> => {
  const forecast: ForecastResult = computeForecast(repo);

  const lines: string[] = [];
  lines.push('# Excel parity — Wave 2d (import)', '');
  lines.push(`- Workbook: \`${summary.workbook}\` / \`${summary.worksheet}\``);
  lines.push(`- Months parsed: ${summary.monthsParsed}`);
  lines.push(`- account.asOf: ${summary.startDate}`);
  lines.push(`- Credit cards created: ${summary.cardsCreated}`);
  lines.push(`- Recurring templates created: ${summary.recurringCreated}`);
  lines.push(`- Ledger entries created: ${summary.ledgerCreated}`);
  lines.push('');

  lines.push('## Credit cards');
  lines.push('');
  const cards = repo.listCards();
  if (cards.length === 0) {
    lines.push('_None._');
  } else {
    lines.push('| Id | Name | Billing day | currentDebit |');
    lines.push('| --- | --- | ---: | ---: |');
    for (const c of cards) {
      lines.push(`| ${c.id} | ${c.name} | ${c.billingDayOfMonth} | ${c.currentDebit.toFixed(2)} |`);
    }
  }
  lines.push('');

  lines.push('## Imported recurring templates');
  lines.push('');
  lines.push('| Description | Channel | Day | Amount |');
  lines.push('| --- | --- | ---: | ---: |');
  for (const t of repo.listRecurring()) {
    lines.push(`| ${t.description} | ${t.channel} | ${t.day} | ${t.amount.toFixed(2)} |`);
  }
  lines.push('');

  lines.push('## Skipped rows');
  lines.push('');
  if (summary.skippedRows.length === 0) {
    lines.push('_None._');
  } else {
    lines.push('| Label | Reason |');
    lines.push('| --- | --- |');
    for (const s of summary.skippedRows) {
      lines.push(`| ${s.label} | ${s.reason} |`);
    }
  }
  lines.push('');

  lines.push('## Anchor balance: Excel vs Forecast');
  lines.push('');
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
  lines.push('');

  // Per-card outstanding at each anchor day vs Excel "карта остаток"
  // (Excel models a single derived "card remaining" row; we attribute it
  //  to the first credit card if there is more than one.)
  const cardRemainsRow = snap.rows.find((r) => r.labelTrimmed === 'карта остаток');
  for (const card of forecast.cards) {
    lines.push(`## Card outstanding: ${card.name} (\`${card.cardId}\`)`);
    lines.push('');
    const showExcel = cardRemainsRow != null && card === forecast.cards[0];
    if (showExcel) {
      lines.push('| Anchor date | Excel «карта остаток» | Forecast outstanding | Diff |');
      lines.push('| --- | ---: | ---: | ---: |');
    } else {
      lines.push('| Anchor date | Forecast outstanding |');
      lines.push('| --- | ---: |');
    }
    for (const m of snap.months) {
      const day = card.days.find((d) => d.date === m.key);
      const f = day?.outstanding ?? null;
      if (showExcel) {
        const excelRaw = cardRemainsRow!.amounts[m.key]?.value;
        const excel = typeof excelRaw === 'number' ? Math.abs(excelRaw) : null;
        const diff = f != null && excel != null ? f - excel : null;
        lines.push(
          `| ${m.key} | ${excel == null ? '—' : excel.toFixed(2)} | ` +
          `${f == null ? '—' : f.toFixed(2)} | ` +
          `${diff == null ? '—' : diff.toFixed(2)} |`,
        );
      } else {
        lines.push(`| ${m.key} | ${f == null ? '—' : f.toFixed(2)} |`);
      }
    }
    lines.push('');
  }

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

  if (snap.months.length === 0) {
    throw new Error('Workbook has no months parsed.');
  }
  if (!snap.balanceRow) {
    throw new Error('Workbook has no balance row.');
  }
  const firstMonth = snap.months[0]!;
  const startBalance = snap.balanceRow.amounts[firstMonth.key]?.value;
  if (typeof startBalance !== 'number') {
    throw new Error(`Balance row has no number value at ${firstMonth.key}`);
  }

  const config = loadConfig({
    ...process.env,
    EXPENSES_SOURCE: process.env.EXPENSES_SOURCE ?? 'dump',
  });
  const dbPath = resolve(repoRoot, config.DB_PATH);
  const db = openDb({ path: dbPath });
  const repo = new StateRepo(db);

  // Idempotent reset: only the singleton tables are wiped (they're re-seeded
  // unconditionally below). Recurring/ledger use stable `excel:` IDs and are
  // reconciled at the end of the import — user-created rows survive.
  db.exec('DELETE FROM credit_card; DELETE FROM account; DELETE FROM settings;');

  // One-time cleanup: prior importer versions used non-stable IDs like
  // `r-zp` / `l-cal-debt-2026-06`. Until the stable-ID refactor those were
  // wiped on each run; now that wholesale truncation is gone, leftover rows
  // would double-count. Drop anything that looks auto-generated by the old
  // importer. (User-created entries via the API get UUIDs.)
  const legacyLedgerPattern = /^l-/;
  const legacyRecurringPattern = /^r-/;
  let legacyLedgerRemoved = 0;
  let legacyRecurringRemoved = 0;
  for (const e of repo.listLedger()) {
    if (!e.id.startsWith(EXCEL_PREFIX) && legacyLedgerPattern.test(e.id)) {
      repo.deleteLedger(e.id);
      legacyLedgerRemoved++;
    }
  }
  for (const t of repo.listRecurring()) {
    if (!t.id.startsWith(EXCEL_PREFIX) && legacyRecurringPattern.test(t.id)) {
      repo.deleteRecurring(t.id);
      legacyRecurringRemoved++;
    }
  }
  if (legacyLedgerRemoved > 0) {
    snap.warnings.push(`Cleaned ${legacyLedgerRemoved} legacy ledger entries`);
  }
  if (legacyRecurringRemoved > 0) {
    snap.warnings.push(`Cleaned ${legacyRecurringRemoved} legacy recurring templates`);
  }

  // Snapshot existing Excel-sourced rows so we can:
  //   (a) preserve `status='cleared'` on already-cleared imported entries,
  //   (b) garbage-collect orphans (excel:* IDs not present in this import).
  const existingLedgerStatus = new Map<string, LedgerEntry['status']>();
  for (const e of repo.listLedger()) {
    if (e.id.startsWith(EXCEL_PREFIX)) existingLedgerStatus.set(e.id, e.status);
  }
  const existingRecurringIds = new Set(
    repo
      .listRecurring()
      .map((r) => r.id)
      .filter((id) => id.startsWith(EXCEL_PREFIX)),
  );
  const touchedLedgerIds = new Set<string>();
  const touchedRecurringIds = new Set<string>();

  repo.upsertAccount({ bankBalance: startBalance, asOf: firstMonth.key });

  repo.upsertSettings({
    threshold: 2000,
    timezone: 'Asia/Jerusalem',
    horizonMonths: Math.max(1, snap.months.length),
    currency: 'ILS',
  });

  // ----- Credit cards -------------------------------------------------------
  // Build a card for each recognised credit-card source. `currentDebit` for a
  // card is the absolute value of the first-month "карта потрачено" row whose
  // source matches the card (Excel models card spend-to-date this way; it
  // becomes a bank pull on the next billing day after asOf).
  const cardSourcesPresent = new Set(
    snap.rows
      .map((r) => r.source.toLowerCase())
      .filter((s) => s in CREDIT_CARD_SOURCES),
  );
  const cardSpentRows = snap.rows.filter(
    (r) => r.labelTrimmed === 'карта потрачено',
  );
  const debitForCard = (cardId: string): number => {
    const row = cardSpentRows.find((r) => r.source.toLowerCase() === cardId);
    if (!row) return 0;
    const v = row.amounts[firstMonth.key]?.value;
    return typeof v === 'number' ? Math.abs(v) : 0;
  };

  let cardsCreated = 0;
  for (const cardId of cardSourcesPresent) {
    const def = CREDIT_CARD_SOURCES[cardId]!;
    const card: CreditCard = {
      id: cardId,
      name: def.name,
      currentDebit: debitForCard(cardId),
      asOf: firstMonth.key,
      billingDayOfMonth: def.billingDay,
    };
    repo.upsertCard(card);
    cardsCreated++;
  }

  const channelForRow = (_row: ExpenseRow): 'bank' => {
    // Excel models every expense (including credit-card purchases) as an
    // immediate bank delta within the column's [prior-anchor, next-anchor]
    // period. We mirror that: imported rows always hit the bank channel.
    // The cc-channel pipeline routing remains available for user-created
    // entries via the UI.
    return 'bank';
  };

  // Maps an Excel column (whose header date is an anchor, e.g. "2026-05" =>
  // 10-May-2026) plus a day-of-month into the first occurrence of that day
  // strictly within the period (anchor, anchor + 1 month]. Day-null rows
  // schedule at the next anchor (default day = anchorDay).
  const anchorDay = 10;
  const scheduleDateForColumn = (
    monthKey: string,
    day: number | null,
  ): string => {
    const d = day ?? anchorDay;
    const [yStr, mStr] = monthKey.split('-');
    let year = Number(yStr);
    let month = Number(mStr);
    if (d <= anchorDay) {
      month += 1;
      if (month > 12) {
        month -= 12;
        year += 1;
      }
    }
    const clamped = Math.min(d, daysInMonth(year, month));
    return `${year}-${pad(month)}-${pad(clamped)}`;
  };

  const { recurringRows, variableRows, skipped } = partitionRows(
    snap.rows,
    snap.months.map((m) => m.key),
  );

  let recurringCreated = 0;
  let ledgerCreated = 0;

  const upsertImportedLedger = (id: string, entry: Omit<LedgerEntry, 'id' | 'status'>): void => {
    // Resolve same-id collisions deterministically — append :2, :3 ... so
    // re-imports keep producing the same suffixes for the same Excel rows.
    let finalId = id;
    let n = 2;
    while (touchedLedgerIds.has(finalId)) finalId = `${id}:${n++}`;
    const status = existingLedgerStatus.get(finalId) ?? 'pending';
    repo.upsertLedger({ ...entry, id: finalId, status });
    touchedLedgerIds.add(finalId);
    ledgerCreated++;
  };

  const upsertImportedRecurring = (id: string, tpl: Omit<RecurringTemplate, 'id'>): void => {
    let finalId = id;
    let n = 2;
    while (touchedRecurringIds.has(finalId)) finalId = `${id}:${n++}`;
    repo.upsertRecurring({ ...tpl, id: finalId });
    touchedRecurringIds.add(finalId);
    recurringCreated++;
  };

  // ----- Card spend ledger entries -----------------------------------------
  // Each «карта потрачено» row has a value per anchor column representing the
  // bank pull on that card's next billing day. The first month is already
  // baked into `currentDebit`; remaining months become ledger entries on the
  // card's billing day within each column's period.
  for (const cardId of cardSourcesPresent) {
    const def = CREDIT_CARD_SOURCES[cardId]!;
    const row = cardSpentRows.find((r) => r.source.toLowerCase() === cardId);
    if (!row) continue;
    for (let i = 1; i < snap.months.length; i++) {
      const m = snap.months[i]!;
      const v = row.amounts[m.key]?.value;
      if (typeof v !== 'number' || v === 0) continue;
      const date = scheduleDateForColumn(m.key, def.billingDay);
      upsertImportedLedger(excelCardBillId(cardId, m.key), {
        description: `${def.name} bill`,
        amount: v,
        channel: 'bank',
        date,
      });
    }
  }

  for (const row of recurringRows) {
    const amount = row.amounts[firstMonth.key]?.value;
    if (typeof amount !== 'number' || row.day == null) continue;
    const channel = channelForRow(row);
    upsertImportedRecurring(excelRecurringId(row), {
      description: describe(row),
      amount,
      channel,
      day: row.day,
      startDate: clampedDate(firstMonth.key, row.day),
      monthEndPolicy: 'clamp',
    });
  }

  for (const row of variableRows) {
    const channel = channelForRow(row);
    for (const m of snap.months) {
      const v = row.amounts[m.key]?.value;
      if (typeof v !== 'number' || v === 0) continue;
      const date = scheduleDateForColumn(m.key, row.day);
      upsertImportedLedger(excelLedgerId(row, m.key), {
        description: describe(row),
        amount: v,
        channel,
        date,
      });
    }
  }

  // Garbage-collect Excel-sourced rows that disappeared from the workbook.
  let orphanedLedger = 0;
  let orphanedRecurring = 0;
  for (const id of existingLedgerStatus.keys()) {
    if (!touchedLedgerIds.has(id)) {
      repo.deleteLedger(id);
      orphanedLedger++;
    }
  }
  for (const id of existingRecurringIds) {
    if (!touchedRecurringIds.has(id)) {
      repo.deleteRecurring(id);
      orphanedRecurring++;
    }
  }
  if (orphanedLedger > 0) {
    snap.warnings.push(`Removed ${orphanedLedger} stale Excel ledger entries`);
  }
  if (orphanedRecurring > 0) {
    snap.warnings.push(`Removed ${orphanedRecurring} stale Excel recurring templates`);
  }

  const summary: ImportSummary = {
    workbook: snap.workbook.name,
    worksheet: snap.workbook.worksheet,
    monthsParsed: snap.months.length,
    startDate: firstMonth.key,
    startBalance,
    cardsCreated,
    recurringCreated,
    ledgerCreated,
    warnings: snap.warnings,
    skippedRows: skipped,
  };

  await writeParityReport(repo, snap, summary);
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
