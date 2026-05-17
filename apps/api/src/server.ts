import 'dotenv/config';
import { resolve } from 'node:path';
import { config as dotenvConfig } from 'dotenv';
import express, {
  type ErrorRequestHandler,
  type Request,
  type RequestHandler,
  type Response,
  type NextFunction,
} from 'express';
import pino from 'pino';
import { pinoHttp } from 'pino-http';
import { findRepoRoot } from './findRepoRoot.js';
import { loadConfig, isGraphConfig, type Config, type GraphConfig } from './config.js';
import { DumpReader, NoDumpFoundError } from './dumpReader.js';
import { GraphClient, GraphError, GraphTimeoutError } from './graph/graphClient.js';
import { GraphReader } from './graph/graphReader.js';
import { WorkbookResolver } from './graph/workbookResolver.js';
import { ExcelWriter } from './graph/excelWriter.js';
import { buildBearerGuard, requireGraphToken } from './auth.js';
import { openDb } from './db/openDb.js';
import { StateRepo } from './db/stateRepo.js';
import { DemoController } from './demo/demoController.js';
import { buildDemoRoutes } from './demo/routes.js';
import { computeForecast } from './forecast/computeForecast.js';
import { buildForecastRoutes } from './forecast/routes.js';
import { buildSyncRoutes } from './sync/routes.js';
import { buildImportRoutes } from './import/routes.js';

// Load .env from the repo root explicitly (avoids cwd ambiguity).
const repoRoot = findRepoRoot();
dotenvConfig({ path: resolve(repoRoot, '.env'), override: false });

const config: Config = loadConfig();

const log = pino({
  level: config.LOG_LEVEL,
  redact: {
    paths: [
      'req.headers.authorization',
      'req.headers["x-ms-graph-token"]',
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

const demoController = new DemoController(stateRepo, dbPath, log);
const getRepo = (): StateRepo => demoController.getRepo();
const isDemo = (): boolean => demoController.isActive();

let graphReader: GraphReader | null = null;
let excelWriter: ExcelWriter | null = null;
let graphResolver: WorkbookResolver | null = null;
let graphClient: GraphClient | null = null;
if (isGraphConfig(config)) {
  graphClient = new GraphClient({
    baseUrl: config.GRAPH_BASE_URL,
    log,
    timeoutMs: config.GRAPH_TIMEOUT_MS,
  });
  // URL priority: settings.workbookUrl > env ONEDRIVE_WORKBOOK_URL. Read at
  // each resolve so edits in Settings take effect without a server restart.
  const getWorkbookUrl = (): string | undefined => {
    const fromDb = getRepo().getSettings().workbookUrl;
    if (fromDb && fromDb.trim() !== '') return fromDb.trim();
    return config.ONEDRIVE_WORKBOOK_URL;
  };
  graphResolver = new WorkbookResolver(graphClient, getWorkbookUrl, log);
  graphReader = new GraphReader({
    client: graphClient,
    resolver: graphResolver,
    worksheetName: config.WORKSHEET_NAME,
    log,
  });
  excelWriter = new ExcelWriter({ client: graphClient, resolver: graphResolver, log });
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
  res.json({
    status: 'ok',
    uptime: process.uptime(),
    source: config.EXPENSES_SOURCE,
    demo: isDemo(),
  });
});

app.get('/api/config', (_req, res) => {
  if (isDemo()) {
    res.json({ source: 'demo', auth: null, demo: true });
    return;
  }
  if (isGraphConfig(config)) {
    const apiScope = (config.API_AUDIENCE || `api://${config.MICROSOFT_CLIENT_ID}`) + '/access';
    res.json({
      source: 'graph',
      auth: {
        clientId: config.MICROSOFT_CLIENT_ID,
        authority: config.MICROSOFT_AUTHORITY,
        // Back-compat field: union of scopes the SPA needs to acquire on
        // initial sign-in (Graph + our API). Kept so existing UI code
        // calling loginRedirect({scopes}) still consents to everything
        // in one prompt.
        scopes: [...config.GRAPH_SCOPES, apiScope],
        // New two-token shape: SPA acquires API token (for /api/*
        // Authorization) and Graph token (for X-MS-Graph-Token) via
        // separate acquireTokenSilent calls, each with its own scope list.
        apiScopes: [apiScope],
        graphScopes: config.GRAPH_SCOPES,
      },
      demo: false,
    });
  } else {
    res.json({ source: 'dump', auth: null, demo: false });
  }
});

// Demo toggle:
// - GET /api/demo is public (just reports state so SPA can decide whether
//   to initialize MSAL).
// - POST /api/demo enabled:true requires a Bearer in protected mode so an
//   attacker cannot flip a legitimate user into demo mode.
// - POST /api/demo enabled:false is always allowed (demo bypasses MSAL,
//   so the SPA holds no Bearer; turning demo OFF only swaps to real
//   data which is itself protected on every read/write route).
const protectApi = config.REQUIRE_AUTH && isGraphConfig(config);

const bearerGuard: RequestHandler | null = protectApi
  ? buildBearerGuard({
      tenantId: config.MICROSOFT_TENANT_ID,
      audiences: [
        // Conventional API audience.
        config.API_AUDIENCE || `api://${(config as GraphConfig).MICROSOFT_CLIENT_ID}`,
        // MSAL.js may emit the bare clientId GUID as `aud` on personal MSA tokens.
        (config as GraphConfig).MICROSOFT_CLIENT_ID,
      ],
      allowedOids: config.ALLOWED_OIDS,
    })
  : null;

app.use(
  '/api',
  buildDemoRoutes(demoController, bearerGuard),
);

// Bearer is required in graph mode, but transparently skipped while demo
// mode is active — the SPA does not initialize MSAL in demo, so no token
// would be sent. Sync/Import additionally 409 in demo (handled in-route).
const conditionalBearer = (
  req: Request,
  res: Response,
  next: NextFunction,
): void => {
  if (isDemo() || !bearerGuard) {
    next();
    return;
  }
  bearerGuard(req, res, next);
};

// Graph-passthrough routes additionally need an X-MS-Graph-Token header
// carrying the user's MS Graph token (acquired by the SPA against the
// Files.ReadWrite / User.Read scopes). The Bearer alone is for our API
// audience — it is NOT usable to call Graph.
const conditionalGraphToken = (
  req: Request,
  res: Response,
  next: NextFunction,
): void => {
  if (isDemo() || !isGraphConfig(config)) {
    next();
    return;
  }
  requireGraphToken(req, res, next);
};
if (protectApi) {
  app.use('/api', conditionalBearer, buildForecastRoutes(getRepo));
  app.use(
    '/api',
    conditionalBearer,
    conditionalGraphToken,
    buildSyncRoutes(getRepo, excelWriter, isDemo),
  );
  app.use(
    '/api',
    conditionalBearer,
    conditionalGraphToken,
    buildImportRoutes(getRepo, graphReader, isDemo, log),
  );
  log.info(
    { allowedOids: config.ALLOWED_OIDS.length },
    'REQUIRE_AUTH=true: forecast + sync routes gated by JWKS-validated Bearer',
  );
} else {
  app.use('/api', buildForecastRoutes(getRepo));
  app.use('/api', conditionalGraphToken, buildSyncRoutes(getRepo, excelWriter, isDemo));
  app.use(
    '/api',
    conditionalGraphToken,
    buildImportRoutes(getRepo, graphReader, isDemo, log),
  );
}

app.get('/api/expenses', graphOrDump(), conditionalGraphToken, async (req, res, next) => {
  try {
    if (isDemo()) {
      res.status(409).json({
        error: 'DEMO_MODE_ACTIVE',
        message: 'Workbook view is disabled in demo mode.',
      });
      return;
    }
    if (graphReader && req.graphToken) {
      const snapshot = await graphReader.readSnapshot(req.graphToken);
      res.json(snapshot);
    } else {
      const snapshot = await dumpReader.readLatestSnapshot();
      res.json(snapshot);
    }
  } catch (err) {
    next(err);
  }
});

app.get('/api/workbook/status', graphOrDump(), conditionalGraphToken, async (req, res, next) => {
  try {
    if (isDemo()) {
      res.status(409).json({
        error: 'DEMO_MODE_ACTIVE',
        message: 'Workbook status is unavailable in demo mode.',
      });
      return;
    }
    if (graphReader && req.graphToken) {
      const meta = await graphReader.readMeta(req.graphToken);
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

if (config.SERVE_SPA) {
  const spaDir = resolve(repoRoot, config.SPA_DIR);
  log.info({ spaDir }, 'serving SPA static files');
  // Hashed assets — long cache; index.html served separately with no-cache.
  app.use(
    express.static(spaDir, {
      index: false,
      maxAge: '1y',
      fallthrough: true,
      setHeaders: (res, filePath) => {
        const base = filePath.split(/[\\/]/).pop() ?? '';
        // Service-worker entrypoint, ngsw control files, and the manifest must
        // never be long-cached or the PWA will not pick up new builds.
        if (
          base === 'ngsw-worker.js' ||
          base === 'safety-worker.js' ||
          base === 'worker-basic.min.js' ||
          base === 'ngsw.json' ||
          base === 'manifest.webmanifest'
        ) {
          res.setHeader('Cache-Control', 'no-cache');
        }
        if (base === 'manifest.webmanifest') {
          res.setHeader('Content-Type', 'application/manifest+json; charset=utf-8');
        }
      },
    }),
  );
  app.get(/.*/, (req, res, next) => {
    // Don't shadow API or healthz; only serve SPA for navigation requests.
    if (req.path.startsWith('/api/') || req.path === '/healthz') return next();
    // Looks like a missing asset (has a file extension) -> 404 instead of index.
    if (/\.[a-zA-Z0-9]{1,8}$/.test(req.path)) return next();
    res.set('Cache-Control', 'no-cache');
    res.sendFile('index.html', { root: spaDir }, (err) => {
      if (err) next(err);
    });
  });
}

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
 * Returns a middleware that requires Bearer auth in graph mode (skipped in
 * demo) and is a no-op in dump mode. Keeps endpoint handlers clean.
 */
function graphOrDump() {
  if (isGraphConfig(config)) return conditionalBearer;
  return (_req: Request, _res: Response, next: NextFunction) => next();
}
