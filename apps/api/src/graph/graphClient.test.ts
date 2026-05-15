import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { GraphClient, GraphError, GraphTimeoutError } from './graphClient.js';
import pino from 'pino';

const log = pino({ level: 'silent' });

function makeClient(opts: Partial<ConstructorParameters<typeof GraphClient>[0]> = {}) {
  return new GraphClient({
    baseUrl: 'https://graph.example.com/v1.0',
    log,
    timeoutMs: 5000,
    maxRetries: 3,
    ...opts,
  });
}

describe('GraphClient', () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it('returns parsed json on success', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ ok: true }), { status: 200 }),
    );
    vi.stubGlobal('fetch', fetchMock);
    const client = makeClient();
    const out = await client.request<{ ok: boolean }>({ path: '/me', accessToken: 'tok' });
    expect(out).toEqual({ ok: true });
    expect(fetchMock).toHaveBeenCalledOnce();
    const [, init] = fetchMock.mock.calls[0]!;
    expect(init.headers.Authorization).toBe('Bearer tok');
  });

  it('throws GraphError on 4xx and does not retry non-retryable', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ error: { code: 'AccessDenied', message: 'no' } }), { status: 403 }),
    );
    vi.stubGlobal('fetch', fetchMock);
    const client = makeClient();
    await expect(client.request({ path: '/x', accessToken: 't' })).rejects.toMatchObject({
      name: 'GraphError',
      status: 403,
      graphCode: 'AccessDenied',
      retryable: false,
    });
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it('retries on 5xx then succeeds', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response('boom', { status: 503 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ ok: 1 }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const client = makeClient({ maxRetries: 2 });
    const result = await client.request({ path: '/x', accessToken: 't' });
    expect(result).toEqual({ ok: 1 });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('gives up after maxRetries on persistent 5xx', async () => {
    const fetchMock = vi.fn().mockImplementation(() => Promise.resolve(new Response('boom', { status: 500 })));
    vi.stubGlobal('fetch', fetchMock);
    const client = makeClient({ maxRetries: 2 });
    await expect(client.request({ path: '/x', accessToken: 't' })).rejects.toMatchObject({
      name: 'GraphError',
      status: 500,
      retryable: true,
    });
    expect(fetchMock).toHaveBeenCalledTimes(3); // initial + 2 retries
  });

  it('retries on 429', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response('throttled', { status: 429 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ ok: 1 }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const client = makeClient({ maxRetries: 1 });
    const out = await client.request({ path: '/x', accessToken: 't' });
    expect(out).toEqual({ ok: 1 });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('throws GraphTimeoutError when fetch is aborted', async () => {
    const fetchMock = vi.fn().mockImplementation((_url, init?: RequestInit) => {
      return new Promise((_, reject) => {
        init?.signal?.addEventListener('abort', () => {
          const err = new Error('Aborted');
          err.name = 'AbortError';
          reject(err);
        });
      });
    });
    vi.stubGlobal('fetch', fetchMock);
    const client = makeClient({ timeoutMs: 50, maxRetries: 0 });
    await expect(client.request({ path: '/x', accessToken: 't' })).rejects.toBeInstanceOf(
      GraphTimeoutError,
    );
  });

  it('parses Graph error envelope correctly', () => {
    const err = new GraphError(404, 'itemNotFound', 'gone', false);
    expect(err.status).toBe(404);
    expect(err.graphCode).toBe('itemNotFound');
    expect(err.retryable).toBe(false);
  });
});
