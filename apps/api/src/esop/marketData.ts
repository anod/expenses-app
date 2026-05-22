export interface EsopMarketQuote {
  symbol: string;
  price: number;
  currency: string | null;
  fetchedAt: string;
}

const YAHOO_CHART_BASE = 'https://query1.finance.yahoo.com/v8/finance/chart';
const DEFAULT_TIMEOUT_MS = 10_000;

export class MarketDataTimeoutError extends Error {
  constructor(message = 'Market data request timed out') {
    super(message);
    this.name = 'MarketDataTimeoutError';
  }
}

export async function fetchYahooQuote(
  symbol: string,
  timeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<EsopMarketQuote> {
  const normalized = symbol.trim();
  if (!normalized) throw new Error('Market symbol is required');
  const url = `${YAHOO_CHART_BASE}/${encodeURIComponent(normalized)}?range=1d&interval=1d`;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      headers: { Accept: 'application/json' },
      signal: ctrl.signal,
    });
    if (!res.ok) {
      throw new Error(`Yahoo Finance quote failed for ${normalized}: ${res.status} ${res.statusText}`);
    }
    const json = (await res.json()) as YahooChartResponse;
    const meta = json.chart?.result?.[0]?.meta;
    const price = meta?.regularMarketPrice ?? meta?.previousClose;
    if (typeof price !== 'number' || !Number.isFinite(price)) {
      throw new Error(`Yahoo Finance quote did not include a price for ${normalized}`);
    }
    return {
      symbol: normalized,
      price,
      currency: typeof meta?.currency === 'string' ? meta.currency : null,
      fetchedAt: new Date().toISOString(),
    };
  } catch (err) {
    if (err instanceof Error && err.name === 'AbortError') {
      throw new MarketDataTimeoutError();
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

interface YahooChartResponse {
  chart?: {
    result?: Array<{
      meta?: {
        regularMarketPrice?: number;
        previousClose?: number;
        currency?: string;
      };
    }>;
  };
}
