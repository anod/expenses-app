import { readFile, readdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { Logger } from 'pino';
import { parseWorkbookDump, type WorkbookSnapshot, type RawWorkbookDump } from '@expenses/shared';

export class DumpReader {
  constructor(
    private readonly dumpsDir: string,
    private readonly log: Logger,
  ) {}

  /** Find the lexicographically latest dump-*.json file in dumpsDir. */
  async findLatest(): Promise<string | null> {
    const dir = resolve(this.dumpsDir);
    const entries = await readdir(dir).catch(() => [] as string[]);
    const dumps = entries.filter((f) => f.startsWith('dump-') && f.endsWith('.json')).sort();
    return dumps.length > 0 ? resolve(dir, dumps[dumps.length - 1]!) : null;
  }

  async readLatestSnapshot(): Promise<WorkbookSnapshot> {
    const path = await this.findLatest();
    if (!path) {
      throw new NoDumpFoundError(`No dump file found in ${this.dumpsDir}. Run \`npm run dump\` first.`);
    }
    this.log.debug({ path }, 'reading dump file');
    const raw = JSON.parse(await readFile(path, 'utf8')) as RawWorkbookDump;
    const snapshot = parseWorkbookDump(raw, { fetchedAt: new Date().toISOString() });
    if (snapshot.warnings.length > 0) {
      this.log.warn({ warnings: snapshot.warnings }, 'snapshot has parser warnings');
    }
    return snapshot;
  }
}

export class NoDumpFoundError extends Error {
  readonly status = 503;
  readonly code = 'NO_DUMP_FOUND';
  constructor(message: string) {
    super(message);
    this.name = 'NoDumpFoundError';
  }
}
