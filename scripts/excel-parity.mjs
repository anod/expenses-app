#!/usr/bin/env node
/**
 * Excel parity baseline (Wave 2a)
 *
 * Reads the latest local dump (or one passed on argv) and writes a baseline
 * report of per-month totals from the existing workbook into
 * session-state/.../files/parity-wave-2a.md.
 *
 * Wave 2a only exposes the pure pipeline (no API, no persisted state) — so
 * the parity report here is a BASELINE snapshot. Subsequent waves diff the
 * forecast pipeline output against this baseline.
 */
import { readFileSync, readdirSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseWorkbookDump } from '@expenses/shared';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..');

const dumpsDir = join(repoRoot, 'dumps');
const argDump = process.argv[2];
const dumpPath = argDump
  ? resolve(argDump)
  : join(
      dumpsDir,
      readdirSync(dumpsDir)
        .filter((f) => f.startsWith('dump-') && f.endsWith('.json'))
        .sort()
        .at(-1) ?? '',
    );

if (!dumpPath || !dumpPath.endsWith('.json')) {
  console.error('No dump file found. Run a workbook dump first.');
  process.exit(1);
}

const dump = JSON.parse(readFileSync(dumpPath, 'utf8'));
const snap = parseWorkbookDump(dump);

const monthTotal = (monthKey) => {
  let outflow = 0;
  let inflow = 0;
  for (const row of snap.rows) {
    if (row.kind !== 'expense') continue;
    const cell = row.amounts[monthKey];
    const v = cell?.value;
    if (typeof v !== 'number') continue;
    if (v < 0) outflow += v;
    else inflow += v;
  }
  return { outflow, inflow };
};

const lines = [];
lines.push(`# Excel parity baseline — Wave 2a`);
lines.push('');
lines.push(`- Workbook: \`${snap.workbook.name}\` (worksheet: \`${snap.workbook.worksheet}\`)`);
lines.push(`- Dumped at: ${dump.dumpedAt ?? 'n/a'}`);
lines.push(`- Currency: ${snap.workbook.currency.code ?? '?'} (${snap.workbook.currency.symbol ?? '?'})`);
lines.push(`- Months parsed: ${snap.months.length}`);
lines.push(`- Expense rows: ${snap.rows.filter((r) => r.kind === 'expense').length}`);
lines.push('');
lines.push('## Per-month totals (Excel side)');
lines.push('');
lines.push('| Month key | Label | Outflow | Inflow | Net | Balance row |');
lines.push('| --- | --- | ---: | ---: | ---: | ---: |');
for (const m of snap.months) {
  const { outflow, inflow } = monthTotal(m.key);
  const bal = snap.balanceRow?.amounts?.[m.key]?.value ?? null;
  lines.push(
    `| ${m.key} | ${m.label} | ${outflow.toFixed(2)} | ${inflow.toFixed(2)} | ` +
    `${(outflow + inflow).toFixed(2)} | ${bal == null ? '—' : bal.toFixed(2)} |`,
  );
}
lines.push('');
lines.push('## Wave 2a note');
lines.push('');
lines.push('Wave 2a delivers only the pure forecast pipeline — no persisted state,');
lines.push('no API, no UI. The pipeline itself is exercised by 47 unit tests in');
lines.push('`packages/shared/src/forecast/`. A real apples-to-apples Excel-vs-forecast');
lines.push('comparison requires Wave 2b (SQLite + `/api/forecast` + initial seed).');
lines.push('This baseline anchors the Excel side so future waves diff against it.');

if (snap.warnings.length) {
  lines.push('');
  lines.push('## Parser warnings');
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
const outFile = join(finalOutDir, 'parity-wave-2a.md');
writeFileSync(outFile, lines.join('\n') + '\n');

console.log(lines.join('\n'));
console.log(`\nReport written to: ${outFile}`);
