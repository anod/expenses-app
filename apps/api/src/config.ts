import { z } from 'zod';

const Common = z.object({
  PORT: z.coerce.number().int().positive().default(4000),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  // Single allow-listed origin for browser CORS. `*` is explicitly rejected
  // because the demo toggle (`POST /api/demo`) is intentionally
  // unauthenticated and relies on an Origin/Referer match against this
  // value to prevent cross-origin abuse from arbitrary websites.
  CORS_ORIGIN: z
    .string()
    .default('http://localhost:4200')
    .refine((v) => v !== '*', {
      message:
        'CORS_ORIGIN=* is not allowed; set it to the SPA origin (scheme + host[+port]).',
    }),
  EXPENSES_SOURCE: z.enum(['graph', 'dump']).default('graph'),
  SERVE_SPA: z
    .union([z.string(), z.boolean()])
    .default(false)
    .transform((v) => v === true || /^(1|true|yes|on)$/i.test(String(v))),
  SPA_DIR: z.string().min(1).default('./apps/web/dist/web/browser'),
  REQUIRE_AUTH: z
    .union([z.string(), z.boolean()])
    .default(false)
    .transform((v) => v === true || /^(1|true|yes|on)$/i.test(String(v))),
  // Personal MSAs always have tid=9188040d-... regardless of which
  // authority alias the SPA points at. Override for org/multi-tenant.
  MICROSOFT_TENANT_ID: z.string().min(1).default('9188040d-6c67-4c5b-b112-36a304b66dad'),
  // CSV list of Microsoft `oid` claims allowed to call the API. Required
  // when REQUIRE_AUTH=true — otherwise ANY consenting MSA user could
  // obtain a valid token for our app and call the API.
  ALLOWED_OIDS: z
    .string()
    .default('')
    .transform((s) => s.split(',').map((x) => x.trim()).filter(Boolean)),
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
  ONEDRIVE_WORKBOOK_URL: z
    .string()
    .url('ONEDRIVE_WORKBOOK_URL must be a URL')
    .optional()
    .or(z.literal('').transform(() => undefined)),
  WORKSHEET_NAME: z.string().min(1).default('Sheet1'),
  ESOP_WORKBOOK_URL: z
    .string()
    .url('ESOP_WORKBOOK_URL must be a URL')
    .optional()
    .or(z.literal('').transform(() => undefined)),
  ESOP_WORKSHEET_NAME: z.string().min(1).default('ESOP'),
  GRAPH_BASE_URL: z.string().url().default('https://graph.microsoft.com/v1.0'),
  GRAPH_TIMEOUT_MS: z.coerce.number().int().positive().default(15_000),
  // The audience our API expects in incoming Bearer tokens. Defaults to
  // `api://<MICROSOFT_CLIENT_ID>` (the conventional API scope URI), but
  // MSAL.js may also emit the bare GUID `aud` for personal MSAs; both
  // forms are accepted in auth.ts.
  API_AUDIENCE: z
    .string()
    .optional()
    .transform((s) => (s && s.length > 0 ? s : undefined)),
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

  if (base.EXPENSES_SOURCE === 'dump') return base;

  const graph = GraphFields.safeParse(env);
  if (!graph.success) bail(graph.error, ' (required when EXPENSES_SOURCE=graph)');
  const merged: GraphConfig = { ...base, ...graph.data };
  if (merged.REQUIRE_AUTH && merged.ALLOWED_OIDS.length === 0) {
    console.error(
      'Invalid configuration: ALLOWED_OIDS must list at least one Microsoft `oid` ' +
      'when REQUIRE_AUTH=true. Otherwise any consenting Microsoft account could ' +
      'obtain a valid token for this app and call the API.',
    );
    process.exit(1);
  }
  return merged;
}

function bail(err: z.ZodError, suffix = ''): never {
  const issues = err.issues.map((i) => `  ${i.path.join('.')}: ${i.message}`).join('\n');
  console.error(`Invalid configuration${suffix}:\n${issues}`);
  process.exit(1);
}
