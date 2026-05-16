#!/usr/bin/env node
/**
 * Excel parity report
 *
 * Usage:
 *   node scripts/excel-parity.mjs            # uses Wave 2a (baseline)
 *   node scripts/excel-parity.mjs --wave 2b  # diff against /api/forecast
 *
 * Wave 2a writes a baseline of per-month Excel totals.
 * Wave 2b queries `/api/forecast` and produces a side-by-side comparison
 * of the projected bank balance at each anchor date (10th of month) vs.
 * the Excel "balance row" for the same date.
 */
import { readFileSync, readdirSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseWorkbookDump } from '@expenses/shared';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..');

const argv = process.argv.slice(2);
const waveIdx = argv.indexOf('--wave');
const wave = waveIdx >= 0 ? argv[waveIdx + 1] : '2a';
const apiUrl = process.env.API_URL ?? 'http://localhost:4000';

const dumpsDir = join(repoRoot, 'dumps');
const dumpPath = join(
  dumpsDir,
  (readdirSync(dumpsDir)
    .filter((f) => f.startsWith('dump-') && f.endsWith('.json'))
    .sort()
    .at(-1)) ?? '',
);
if (!dumpPath.endsWith('.json')) {
  console.error('No dump file found. Run a workbook dump first.');
  process.exit(1);
}
const dump = JSON.parse(readFileSync(dumpPath, 'utf8'));
const snap = parseWorkbookDump(dump);

const monthTotal = (key) => {
  let outflow = 0;
  let inflow = 0;
  for (const row of snap.rows) {
    if (row.kind !== 'expense') continue;
    const v = row.amounts[key]?.value;
    if (typeof v !== 'number') continue;
    if (v < 0) outflow += v;
    else inflow += v;
  }
  return { outflow, inflow };
};

const lines = [];

if (wave === '2a') {
  lines.push('# Excel parity baseline — Wave 2a', '');
  lines.push(`- Workbook: \`${snap.workbook.name}\` / \`${snap.workbook.worksheet}\``);
  lines.push(`- Dumped at: ${dump.dumpedAt ?? 'n/a'}`);
  lines.push(`- Currency: ${snap.workbook.currency.code ?? '?'}`);
  lines.push(`- Months parsed: ${snap.months.length}`, '');
  lines.push('## Per-month totals (Excel side)', '');
  lines.push('| Month key | Outflow | Inflow | Net | Balance row |');
  lines.push('| --- | ---: | ---: | ---: | ---: |');
  for (const m of snap.months) {
    const { outflow, inflow } = monthTotal(m.key);
    const bal = snap.balanceRow?.amounts?.[m.key]?.value ?? null;
    lines.push(
      `| ${m.key} | ${outflow.toFixed(2)} | ${inflow.toFixed(2)} | ${(outflow + inflow).toFixed(2)} | ${bal == null ? '—' : bal.toFixed(2)} |`,
    );
  }
} else if (wave === '2b') {
  // Fetch /api/forecast
  const resp = await fetch(`${apiUrl}/api/forecast`);
  if (!resp.ok) {
    console.error(`GET ${apiUrl}/api/forecast → ${resp.status}`);
    process.exit(1);
  }
  const forecast = await resp.json();

  lines.push('# Excel parity diff — Wave 2b', '');
  lines.push(`- API: \`${apiUrl}/api/forecast\``);
  lines.push(`- Forecast horizon: ${forecast.startDate} → ${forecast.endDate}`);
  lines.push(`- Forecast status: **${forecast.status}** (min ${forecast.minBalance.toFixed(2)} on ${forecast.minBalanceDate})`);
  lines.push('');
  lines.push('## Per-month-anchor comparison');
  lines.push('');
  lines.push('| Anchor date | Excel balance | Forecast balance | Diff |');
  lines.push('| --- | ---: | ---: | ---: |');
  for (const m of snap.months) {
    const excelBal = snap.balanceRow?.amounts?.[m.key]?.value ?? null;
    const fd = forecast.days.find((d) => d.date === m.key);
    if (!fd && excelBal == null) continue;
    const fcst = fd ? fd.balance : null;
    const diff = fcst != null && excelBal != null ? fcst - excelBal : null;
    lines.push(
      `| ${m.key} | ${excelBal == null ? '—' : excelBal.toFixed(2)} | ${fcst == null ? '—' : fcst.toFixed(2)} | ${diff == null ? '—' : diff.toFixed(2)} |`,
    );
  }
  lines.push('');
  lines.push('## Wave 2b note');
  lines.push('');
  lines.push('Wave 2b ships SQLite + `/api/forecast`. With an EMPTY database the');
  lines.push('forecast will be flat (balance=0), so big diffs vs. Excel are expected.');
  lines.push('The diff column becomes meaningful once Wave 2c lets you upsert');
  lines.push('Account/Cards/Ledger/Recurring (or once Wave 2b adds an Excel→SQLite');
  lines.push('seed). At that point any non-zero diff is a real parity bug.');
} else {
  console.error(`Unknown wave: ${wave}`);
  process.exit(1);
}

if (snap.warnings.length) {
  lines.push('', '## Parser warnings');
  for (const w of snap.warnings) lines.push(`- ${w}`);
}

const sessionRoot = process.env.HOME
  ? join(process.env.HOME, '.copilot', 'session-state')
  : null;
let resolvedOutDir = null;
if (sessionRoot) {
  try {
    const sessions = readdirSync(sessionRoot);
    const session = sessions.find((s) => /^[0-9a-f-]{36}$/.test(s));
    if (session) resolvedOutDir = join(sessionRoot, session, 'files');
  } catch {
    // ignore
  }
}
const finalOutDir = resolvedOutDir ?? join(repoRoot, 'scripts', 'output');
mkdirSync(finalOutDir, { recursive: true });
const outFile = join(finalOutDir, `parity-wave-${wave}.md`);
writeFileSync(outFile, lines.join('\n') + '\n');

console.log(lines.join('\n'));
console.log(`\nReport written to: ${outFile}`);

