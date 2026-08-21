import type { ErrorRequestHandler, Request, Response, NextFunction } from 'express';
import { NoDumpFoundError } from './dumpReader.js';
import { GraphError, GraphTimeoutError } from './graph/graphClient.js';
import { MarketDataTimeoutError } from './esop/marketData.js';

/**
 * Reads a client-error status off a thrown value.
 *
 * Route guards (`validateNoFutureAsOf`, `validateChannel`) reject bad input by
 * throwing a plain `Error` tagged with `status = 400`, and `express.json()`
 * tags a malformed body the same way. Without this the fallback below would
 * report all of them as `500 INTERNAL_ERROR`, hiding the actual reason from
 * the SPA and logging routine user mistakes as server faults.
 */
const clientStatusOf = (err: unknown): number | null => {
  if (typeof err !== 'object' || err === null) return null;
  const raw = err as { status?: unknown; statusCode?: unknown };
  const status = typeof raw.status === 'number' ? raw.status : raw.statusCode;
  return typeof status === 'number' && status >= 400 && status < 500 ? status : null;
};

const codeOf = (err: unknown, fallback: string): string => {
  const code = (err as { code?: unknown } | null)?.code;
  return typeof code === 'string' && code.length > 0 ? code : fallback;
};

export const errorHandler: ErrorRequestHandler = (
  err: unknown,
  req: Request,
  res: Response,
  _next: NextFunction,
) => {
  if (err instanceof NoDumpFoundError) {
    req.log.warn({ err }, 'no dump available');
    res.status(err.status).json({ error: err.code, message: err.message });
    return;
  }
  if (err instanceof GraphError) {
    const code = err.graphCode ?? 'GRAPH_ERROR';
    let status = err.status;
    let actionable = err.message;
    if (err.status === 401) {
      actionable = 'Microsoft Graph rejected the access token. Sign in again.';
    } else if (err.status === 403) {
      actionable = `Microsoft Graph denied access (${code}). Check that the signed-in account has access to the workbook and that scopes ${'GRAPH_SCOPES'} are granted.`;
    } else if (err.status === 404) {
      actionable = `Workbook or worksheet not found (${code}). Verify ONEDRIVE_WORKBOOK_URL and WORKSHEET_NAME.`;
    } else if (err.status >= 500 && err.status < 600) {
      status = 502;
    }
    req.log.warn({ status: err.status, code, retryable: err.retryable }, 'graph error');
    res.status(status).json({ error: code, message: actionable });
    return;
  }
  if (err instanceof GraphTimeoutError) {
    req.log.warn('graph request timed out');
    res.status(504).json({ error: 'GRAPH_TIMEOUT', message: err.message });
    return;
  }
  if (err instanceof MarketDataTimeoutError) {
    req.log.warn('market data request timed out');
    res.status(504).json({ error: 'MARKET_DATA_TIMEOUT', message: err.message });
    return;
  }
  const message = err instanceof Error ? err.message : String(err);
  const clientStatus = clientStatusOf(err);
  if (clientStatus !== null) {
    req.log.warn({ err }, 'client error');
    res.status(clientStatus).json({ error: codeOf(err, 'BAD_REQUEST'), message });
    return;
  }
  req.log.error({ err }, 'unhandled error');
  res.status(500).json({ error: 'INTERNAL_ERROR', message });
};
