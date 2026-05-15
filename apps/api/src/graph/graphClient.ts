import type { Logger } from 'pino';

export interface GraphClientOptions {
  baseUrl: string;
  log: Logger;
  timeoutMs: number;
  maxRetries?: number;
}

export interface GraphRequest {
  method?: 'GET' | 'POST' | 'PATCH' | 'DELETE';
  path: string;
  accessToken: string;
  body?: unknown;
  headers?: Record<string, string>;
}

export class GraphError extends Error {
  constructor(
    readonly status: number,
    readonly graphCode: string | null,
    message: string,
    readonly retryable: boolean,
  ) {
    super(message);
    this.name = 'GraphError';
  }
}

export class GraphTimeoutError extends Error {
  readonly status = 504;
  constructor(message = 'Graph request timed out') {
    super(message);
    this.name = 'GraphTimeoutError';
  }
}

export class GraphClient {
  private readonly maxRetries: number;

  constructor(private readonly opts: GraphClientOptions) {
    this.maxRetries = opts.maxRetries ?? 3;
  }

  async request<T = unknown>(req: GraphRequest): Promise<T> {
    let attempt = 0;
    while (true) {
      try {
        return await this.send<T>(req);
      } catch (err) {
        attempt++;
        const retryable = err instanceof GraphError ? err.retryable : err instanceof GraphTimeoutError;
        if (!retryable || attempt > this.maxRetries) throw err;
        const delay = this.computeDelay(attempt, err);
        this.opts.log.warn(
          { attempt, delayMs: delay, status: err instanceof GraphError ? err.status : 'timeout' },
          'graph request retrying',
        );
        await sleep(delay);
      }
    }
  }

  private async send<T>(req: GraphRequest): Promise<T> {
    const url = req.path.startsWith('http') ? req.path : `${this.opts.baseUrl}${req.path}`;
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), this.opts.timeoutMs);
    try {
      const init: RequestInit = {
        method: req.method ?? 'GET',
        headers: {
          Authorization: `Bearer ${req.accessToken}`,
          Accept: 'application/json',
          ...(req.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
          ...req.headers,
        },
        signal: ctrl.signal,
      };
      if (req.body !== undefined) init.body = JSON.stringify(req.body);
      const res = await fetch(url, init);

      if (res.status === 204) return undefined as T;

      const text = await res.text();
      const json: unknown = text ? safeJson(text) : null;

      if (!res.ok) {
        const { code, message } = extractGraphError(json);
        const retryable = res.status === 429 || (res.status >= 500 && res.status < 600);
        throw new GraphError(res.status, code, message ?? `Graph ${res.status}`, retryable);
      }

      return json as T;
    } catch (err) {
      if (err instanceof GraphError) throw err;
      if (err instanceof Error && err.name === 'AbortError') throw new GraphTimeoutError();
      throw err;
    } finally {
      clearTimeout(timer);
    }
  }

  private computeDelay(attempt: number, err: unknown): number {
    if (err instanceof GraphError && err.status === 429) {
      // Honor Retry-After if we have it on the error (we don't currently surface
      // the header — fall back to standard backoff). TODO: lift Retry-After up.
    }
    const base = 250;
    const cap = 8000;
    const exp = Math.min(cap, base * 2 ** (attempt - 1));
    const jitter = Math.random() * exp * 0.5;
    return Math.floor(exp + jitter);
  }
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function extractGraphError(json: unknown): { code: string | null; message: string | null } {
  if (json && typeof json === 'object' && 'error' in json) {
    const err = (json as { error: unknown }).error;
    if (err && typeof err === 'object') {
      const code = 'code' in err ? String((err as { code: unknown }).code) : null;
      const message = 'message' in err ? String((err as { message: unknown }).message) : null;
      return { code, message };
    }
  }
  return { code: null, message: null };
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
