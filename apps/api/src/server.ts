import express, { type ErrorRequestHandler, type Request, type Response, type NextFunction } from 'express';
import pino from 'pino';
import { pinoHttp } from 'pino-http';
import { loadConfig } from './config.js';
import { DumpReader, NoDumpFoundError } from './dumpReader.js';

const config = loadConfig();

const log = pino(
  config.NODE_ENV === 'development'
    ? {
        level: config.LOG_LEVEL,
        transport: { target: 'pino-pretty', options: { colorize: true, translateTime: 'SYS:HH:MM:ss' } },
      }
    : { level: config.LOG_LEVEL },
);

const dumpReader = new DumpReader(config.DUMPS_DIR, log);

const app = express();

app.use(pinoHttp({ logger: log }));

// CORS for local dev (Angular at :4200 → API at :4000)
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', config.CORS_ORIGIN);
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PATCH,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') {
    res.status(204).end();
    return;
  }
  next();
});

app.use(express.json({ limit: '100kb' }));

app.get('/healthz', (_req, res) => {
  res.json({ status: 'ok', uptime: process.uptime() });
});

app.get('/api/expenses', async (_req, res, next) => {
  try {
    const snapshot = await dumpReader.readLatestSnapshot();
    res.json(snapshot);
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
  const message = err instanceof Error ? err.message : String(err);
  req.log.error({ err }, 'unhandled error');
  res.status(500).json({ error: 'INTERNAL_ERROR', message });
};
app.use(errorHandler);

const server = app.listen(config.PORT, () => {
  log.info({ port: config.PORT, dumpsDir: config.DUMPS_DIR }, 'API listening');
});

const shutdown = (signal: string) => {
  log.info({ signal }, 'shutting down');
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 5000).unref();
};
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
