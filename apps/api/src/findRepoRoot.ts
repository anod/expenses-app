import { existsSync, statSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Walk up from `start` looking for a marker file/dir that identifies the
 * workspace root. Used to resolve `.env` and dump paths reliably regardless
 * of cwd (npm script, docker, IDE run config, etc).
 */
export function findRepoRoot(start: string = fileURLToPath(import.meta.url)): string {
  const markers = ['package-lock.json', 'pnpm-lock.yaml', 'yarn.lock'];
  let dir = resolve(start);
  if (existsSync(dir) && !statSync(dir).isDirectory()) {
    dir = dirname(dir);
  }
  for (let i = 0; i < 12; i++) {
    for (const marker of markers) {
      if (existsSync(resolve(dir, marker))) return dir;
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return process.cwd();
}
