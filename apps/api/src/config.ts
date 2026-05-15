import { z } from 'zod';

const Schema = z.object({
  PORT: z.coerce.number().int().positive().default(4000),
  DUMPS_DIR: z.string().min(1).default('../../dumps'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  CORS_ORIGIN: z.string().default('http://localhost:4200'),
});

export type Config = z.infer<typeof Schema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const result = Schema.safeParse(env);
  if (!result.success) {
    const issues = result.error.issues.map((i) => `  ${i.path.join('.')}: ${i.message}`).join('\n');
    console.error(`Invalid configuration:\n${issues}`);
    process.exit(1);
  }
  return result.data;
}
