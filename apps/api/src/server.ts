import 'dotenv/config';
import { resolve } from 'node:path';
import { config as dotenvConfig } from 'dotenv';
import express, {
  type ErrorRequestHandler,
  type Request,
  type Response,
  type NextFunction,
} from 'express';
import pino from 'pino';
import { pinoHttp } from 'pino-http';
import { findRepoRoot } from './findRepoRoot.js';
import { loadConfig, isGraphConfig, type Config } from './config.js';
import { DumpReader, NoDumpFoundError } from './dumpReader.js';
import { GraphClient, GraphError, GraphTimeoutError } from './graph/graphClient.js';
import { GraphReader } from './graph/graphReader.js';
import { WorkbookResolver } from './graph/workbookResolver.js';
import { requireBearer } from './auth.js';
import { openDb } from './db/openDb.js';
import { StateRepo } from './db/stateRepo.js';
import { computeForecast } from './forecast/computeForecast.js';

// Load .env from the repo root explicitly (avoids cwd ambiguity).
const repoRoot = findRepoRoot();
dotenvConfig({ path: resolve(repoRoot, '.env'), override: false });

const config: Config = loadConfig();

const log = pino({
  level: config.LOG_LEVEL,
  redact: {
    paths: [
      'req.headers.authorization',
      'res.headers["set-cookie"]',
      '*.accessToken',
      '*.access_token',
      '*.refresh_token',
      '*.refreshToken',
      '*.idToken',
      '*.id_token',
      '*.secret',
    ],
    censor: '[REDACTED]',
  },
  ...(config.NODE_ENV === 'development'
    ? {
        transport: {
          target: 'pino-pretty',
          options: { colorize: true, translateTime: 'SYS:HH:MM:ss' },
        },
      }
    : {}),
});

log.info(
  {
    source: config.EXPENSES_SOURCE,
    repoRoot,
    port: config.PORT,
    ...(isGraphConfig(config)
      ? {
          authority: config.MICROSOFT_AUTHORITY,
          scopes: config.GRAPH_SCOPES,
          worksheet: config.WORKSHEET_NAME,
        }
      : { dumpsDir: config.DUMPS_DIR }),
  },
  'starting api',
);

// Adapters
const dumpReader = new DumpReader(resolve(repoRoot, config.DUMPS_DIR), log);

const dbPath = resolve(repoRoot, config.DB_PATH);
const db = openDb({ path: dbPath });
const stateRepo = new StateRepo(db);
log.info({ dbPath }, 'sqlite ready');

let graphReader: GraphReader | null = null;
if (isGraphConfig(config)) {
  const graphClient = new GraphClient({
    baseUrl: config.GRAPH_BASE_URL,
    log,
    timeoutMs: config.GRAPH_TIMEOUT_MS,
  });
  const resolver = new WorkbookResolver(graphClient, config.ONEDRIVE_WORKBOOK_URL, log);
  graphReader = new GraphReader({
    client: graphClient,
    resolver,
    worksheetName: config.WORKSHEET_NAME,
    log,
  });
}

const app = express();

app.use(pinoHttp({ logger: log }));

app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', config.CORS_ORIGIN);
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PATCH,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type,Authorization');
  res.setHeader('Vary', 'Origin');
  if (req.method === 'OPTIONS') {
    res.status(204).end();
    return;
  }
  next();
});

app.use(express.json({ limit: '100kb' }));

app.get('/healthz', (_req, res) => {
  res.json({ status: 'ok', uptime: process.uptime(), source: config.EXPENSES_SOURCE });
});

app.get('/api/config', (_req, res) => {
  if (isGraphConfig(config)) {
    res.json({
      source: 'graph',
      auth: {
        clientId: config.MICROSOFT_CLIENT_ID,
        authority: config.MICROSOFT_AUTHORITY,
        scopes: config.GRAPH_SCOPES,
      },
    });
  } else {
    res.json({ source: 'dump', auth: null });
  }
});

app.get('/api/forecast', (_req, res, next) => {
  try {
    const result = computeForecast(stateRepo);
    res.json(result);
  } catch (err) {
    next(err);
  }
});

app.get('/api/expenses', graphOrDump(), async (req, res, next) => {
  try {
    if (graphReader && req.accessToken) {
      const snapshot = await graphReader.readSnapshot(req.accessToken);
      res.json(snapshot);
    } else {
      const snapshot = await dumpReader.readLatestSnapshot();
      res.json(snapshot);
    }
  } catch (err) {
    next(err);
  }
});

app.get('/api/workbook/status', graphOrDump(), async (req, res, next) => {
  try {
    if (graphReader && req.accessToken) {
      const meta = await graphReader.readMeta(req.accessToken);
      res.json({
        source: 'graph',
        workbook: meta,
        fetchedAt: new Date().toISOString(),
      });
    } else {
      const snapshot = await dumpReader.readLatestSnapshot();
      res.json({
        source: 'dump',
        workbook: snapshot.workbook,
        fetchedAt: snapshot.workbook.fetchedAt,
      });
    }
  } catch (err) {
    next(err);
  }
});

const errorHandler: ErrorRequestHandler = (err: unknown, req: Request, res: Response, _next: NextFunction) => {
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
  const message = err instanceof Error ? err.message : String(err);
  req.log.error({ err }, 'unhandled error');
  res.status(500).json({ error: 'INTERNAL_ERROR', message });
};
app.use(errorHandler);

const server = app.listen(config.PORT, () => {
  log.info({ port: config.PORT }, 'API listening');
});

const shutdown = (signal: string) => {
  log.info({ signal }, 'shutting down');
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 5000).unref();
};
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

/**
 * Returns a middleware that requires Bearer auth in graph mode and is a
 * no-op in dump mode. This keeps endpoint handlers clean.
 */
function graphOrDump() {
  if (isGraphConfig(config)) return requireBearer;
  return (_req: Request, _res: Response, next: NextFunction) => next();
}
