import { describe, expect, it, vi } from 'vitest';
import pino from 'pino';
import { encodeSharingUrl, WorkbookResolver } from './workbookResolver.js';
import { GraphClient, GraphError } from './graphClient.js';

const log = pino({ level: 'silent' });

describe('encodeSharingUrl', () => {
  it('matches Microsoft Graph reference encoding', () => {
    // From MS docs: "https://onedrive.live.com/redir?resid=1231244193912!12&authKey=1201919!12921!1"
    // -> "u!aHR0cHM6Ly9vbmVkcml2ZS5saXZlLmNvbS9yZWRpcj9yZXNpZD0xMjMxMjQ0MTkzOTEyITEyJmF1dGhLZXk9MTIwMTkxOSExMjkyMSEx"
    const url = 'https://onedrive.live.com/redir?resid=1231244193912!12&authKey=1201919!12921!1';
    expect(encodeSharingUrl(url)).toBe(
      'u!aHR0cHM6Ly9vbmVkcml2ZS5saXZlLmNvbS9yZWRpcj9yZXNpZD0xMjMxMjQ0MTkzOTEyITEyJmF1dGhLZXk9MTIwMTkxOSExMjkyMSEx',
    );
  });

  it('strips padding and uses URL-safe alphabet', () => {
    const out = encodeSharingUrl('a?b/c+d=='); // base64 has +, /, = which must be replaced/stripped
    expect(out).not.toMatch(/[+/=]/);
    expect(out.startsWith('u!')).toBe(true);
  });
});

describe('WorkbookResolver', () => {
  function fakeClient(impl: (req: { path: string }) => unknown): GraphClient {
    const c = Object.create(GraphClient.prototype) as GraphClient;
    (c as unknown as { request: typeof GraphClient.prototype.request }).request = (async (req) =>
      impl(req)) as typeof GraphClient.prototype.request;
    return c;
  }

  it('caches resolution after first success', async () => {
    const calls: string[] = [];
    const client = fakeClient((req) => {
      calls.push(req.path);
      return {
        id: 'item-1',
        name: 'Expenses.xlsx',
        parentReference: { driveId: 'drive-1' },
        lastModifiedDateTime: '2026-05-15T20:00:00Z',
        webUrl: 'https://example/x',
      };
    });
    const r = new WorkbookResolver(client, () => 'https://onedrive/x', log);
    const a = await r.resolve('tok');
    const b = await r.resolve('tok');
    expect(a).toEqual(b);
    expect(a.driveId).toBe('drive-1');
    expect(a.itemId).toBe('item-1');
    expect(calls).toHaveLength(1);
  });

  it('invalidates cache on 404', async () => {
    const client = fakeClient(() => {
      throw new GraphError(404, 'itemNotFound', 'gone', false);
    });
    const r = new WorkbookResolver(client, () => 'https://onedrive/x', log);
    await expect(r.resolve('tok')).rejects.toBeInstanceOf(GraphError);
    // After invalidation, the next call should also try (and fail again).
    await expect(r.resolve('tok')).rejects.toBeInstanceOf(GraphError);
  });

  it('rejects responses missing driveId or itemId', async () => {
    const client = fakeClient(() => ({ id: 'x', name: 'n', parentReference: {} }));
    const r = new WorkbookResolver(client, () => 'https://onedrive/x', log);
    await expect(r.resolve('tok')).rejects.toThrow(/missing driveId or itemId/);
  });

  it('manual invalidate clears cache', async () => {
    let count = 0;
    const client = fakeClient(() => {
      count++;
      return {
        id: 'item-1',
        name: 'Expenses.xlsx',
        parentReference: { driveId: 'drive-1' },
      };
    });
    const r = new WorkbookResolver(client, () => 'https://onedrive/x', log);
    await r.resolve('tok');
    r.invalidate();
    await r.resolve('tok');
    expect(count).toBe(2);
  });
});
