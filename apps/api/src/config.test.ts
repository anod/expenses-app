import { describe, expect, it } from 'vitest';
import { isGraphConfig, loadConfig } from './config.js';

const baseEnv = {
  PORT: '4000',
  LOG_LEVEL: 'info',
  NODE_ENV: 'test',
  CORS_ORIGIN: 'http://localhost:4200',
};

describe('loadConfig', () => {
  it('dump mode requires only DUMPS_DIR (with default)', () => {
    const c = loadConfig({ ...baseEnv, EXPENSES_SOURCE: 'dump' } as NodeJS.ProcessEnv);
    expect(c.EXPENSES_SOURCE).toBe('dump');
    expect(isGraphConfig(c)).toBe(false);
    expect(c.DUMPS_DIR).toBe('./dumps');
  });

  it('graph mode requires MICROSOFT_CLIENT_ID and ONEDRIVE_WORKBOOK_URL', () => {
    const exit = mockExit();
    try {
      loadConfig({
        ...baseEnv,
        EXPENSES_SOURCE: 'graph',
      } as NodeJS.ProcessEnv);
    } catch {
      // process.exit was called (mocked to throw)
    }
    expect(exit.calls.length).toBeGreaterThan(0);
    exit.restore();
  });

  it('graph mode parses scopes from comma-separated string', () => {
    const c = loadConfig({
      ...baseEnv,
      EXPENSES_SOURCE: 'graph',
      MICROSOFT_CLIENT_ID: '00000000-0000-0000-0000-000000000001',
      ONEDRIVE_WORKBOOK_URL: 'https://onedrive.live.com/edit?something',
      GRAPH_SCOPES: 'Files.Read, User.Read , offline_access',
    } as NodeJS.ProcessEnv);
    if (!isGraphConfig(c)) throw new Error('expected graph');
    expect(c.GRAPH_SCOPES).toEqual(['Files.Read', 'User.Read', 'offline_access']);
    expect(c.MICROSOFT_AUTHORITY).toBe('https://login.microsoftonline.com/consumers');
    expect(c.WORKSHEET_NAME).toBe('Sheet1');
  });

  it('treats empty API_AUDIENCE as undefined (regression: scope was "/access")', () => {
    const c = loadConfig({
      ...baseEnv,
      EXPENSES_SOURCE: 'graph',
      MICROSOFT_CLIENT_ID: '00000000-0000-0000-0000-000000000001',
      ONEDRIVE_WORKBOOK_URL: 'https://onedrive.live.com/edit?something',
      API_AUDIENCE: '',
    } as NodeJS.ProcessEnv);
    if (!isGraphConfig(c)) throw new Error('expected graph');
    expect(c.API_AUDIENCE).toBeUndefined();
  });
});

function mockExit() {
  const origExit = process.exit;
  const origErr = console.error;
  const calls: unknown[] = [];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  process.exit = ((code?: number) => {
    calls.push(code);
    throw new Error(`exit-${code ?? 0}`);
  }) as never;
  console.error = () => {};
  return {
    calls,
    restore() {
      process.exit = origExit;
      console.error = origErr;
    },
  };
}
