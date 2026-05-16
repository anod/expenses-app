import { z } from 'zod';

const Common = z.object({
  PORT: z.coerce.number().int().positive().default(4000),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  CORS_ORIGIN: z.string().default('http://localhost:4200'),
  EXPENSES_SOURCE: z.enum(['graph', 'dump']).default('graph'),
  DEMO_MODE: z
    .union([z.string(), z.boolean()])
    .default(false)
    .transform((v) => v === true || /^(1|true|yes|on)$/i.test(String(v))),
  SERVE_SPA: z
    .union([z.string(), z.boolean()])
    .default(false)
    .transform((v) => v === true || /^(1|true|yes|on)$/i.test(String(v))),
  SPA_DIR: z.string().min(1).default('./apps/web/dist/web/browser'),
  REQUIRE_AUTH: z
    .union([z.string(), z.boolean()])
    .default(false)
    .transform((v) => v === true || /^(1|true|yes|on)$/i.test(String(v))),
});

const DumpFields = z.object({
  DUMPS_DIR: z.string().min(1).default('./dumps'),
  DB_PATH: z.string().min(1).default('./data/expenses.db'),
});

const GraphFields = z.object({
  MICROSOFT_CLIENT_ID: z.string().uuid('MICROSOFT_CLIENT_ID must be a GUID'),
  MICROSOFT_AUTHORITY: z.string().url().default('https://login.microsoftonline.com/consumers'),
  GRAPH_SCOPES: z
    .string()
    .default('Files.ReadWrite,User.Read')
    .transform((s) => s.split(',').map((x) => x.trim()).filter(Boolean)),
  ONEDRIVE_WORKBOOK_URL: z.string().url('ONEDRIVE_WORKBOOK_URL must be a URL'),
  WORKSHEET_NAME: z.string().min(1).default('Sheet1'),
  GRAPH_BASE_URL: z.string().url().default('https://graph.microsoft.com/v1.0'),
  GRAPH_TIMEOUT_MS: z.coerce.number().int().positive().default(15_000),
});

export type CommonConfig = z.infer<typeof Common>;
export type DumpConfig = CommonConfig & z.infer<typeof DumpFields>;
export type GraphConfig = CommonConfig & z.infer<typeof DumpFields> & z.infer<typeof GraphFields>;
export type Config = DumpConfig | GraphConfig;

export function isGraphConfig(c: Config): c is GraphConfig {
  return c.EXPENSES_SOURCE === 'graph';
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const common = Common.safeParse(env);
  if (!common.success) bail(common.error);
  const dump = DumpFields.safeParse(env);
  if (!dump.success) bail(dump.error);

  const base = { ...common.data, ...dump.data };

  // Demo mode forces dump-source semantics (no Graph, no real DB writes).
  if (base.DEMO_MODE) return { ...base, EXPENSES_SOURCE: 'dump' };

  if (base.EXPENSES_SOURCE === 'dump') return base;

  const graph = GraphFields.safeParse(env);
  if (!graph.success) bail(graph.error, ' (required when EXPENSES_SOURCE=graph)');
  return { ...base, ...graph.data };
}

function bail(err: z.ZodError, suffix = ''): never {
  const issues = err.issues.map((i) => `  ${i.path.join('.')}: ${i.message}`).join('\n');
  console.error(`Invalid configuration${suffix}:\n${issues}`);
  process.exit(1);
}
