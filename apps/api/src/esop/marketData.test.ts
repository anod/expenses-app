import { afterEach, describe, expect, it, vi } from 'vitest';
import { fetchYahooQuote, MarketDataTimeoutError } from './marketData.js';

describe('fetchYahooQuote', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it('returns a normalized quote from Yahoo chart metadata', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      yahooResponse({ regularMarketPrice: 123.45, currency: 'USD' }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const quote = await fetchYahooQuote(' MNDY ');

    expect(quote).toMatchObject({ symbol: 'MNDY', price: 123.45, currency: 'USD' });
    expect(Date.parse(quote.fetchedAt)).not.toBeNaN();
    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('https://query1.finance.yahoo.com/v8/finance/chart/MNDY?range=1d&interval=1d');
    expect(init).toMatchObject({ headers: { Accept: 'application/json' } });
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it('falls back to previous close when regular market price is absent', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(yahooResponse({ previousClose: 3.72 })));

    await expect(fetchYahooQuote('USDILS=X')).resolves.toMatchObject({
      symbol: 'USDILS=X',
      price: 3.72,
      currency: null,
    });
  });

  it('rejects blank symbols before making a request', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    await expect(fetchYahooQuote('   ')).rejects.toThrow('Market symbol is required');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('throws when Yahoo returns a non-success response', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('nope', {
      status: 502,
      statusText: 'Bad Gateway',
    })));

    await expect(fetchYahooQuote('MNDY')).rejects.toThrow(
      'Yahoo Finance quote failed for MNDY: 502 Bad Gateway',
    );
  });

  it('throws when Yahoo omits usable price metadata', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(yahooResponse({ currency: 'USD' })));

    await expect(fetchYahooQuote('MNDY')).rejects.toThrow(
      'Yahoo Finance quote did not include a price for MNDY',
    );
  });

  it('surfaces network errors without rewriting them', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('socket hang up')));

    await expect(fetchYahooQuote('MNDY')).rejects.toThrow('socket hang up');
  });

  it('aborts slow Yahoo requests', async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn().mockImplementation((_url: string, init?: RequestInit) => {
      return new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => {
          const err = new Error('Aborted');
          err.name = 'AbortError';
          reject(err);
        });
      });
    });
    vi.stubGlobal('fetch', fetchMock);

    const quote = expect(fetchYahooQuote('MNDY', 50)).rejects.toBeInstanceOf(
      MarketDataTimeoutError,
    );
    await vi.advanceTimersByTimeAsync(50);

    await quote;
  });
});

function yahooResponse(meta: Record<string, unknown>): Response {
  return new Response(JSON.stringify({ chart: { result: [{ meta }] } }), { status: 200 });
}
