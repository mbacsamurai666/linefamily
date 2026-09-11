import { z } from 'zod';

const bool = z
  .string()
  .default('false')
  .transform((v) => v.toLowerCase() === 'true' || v === '1');

const csv = z
  .string()
  .default('')
  .transform((v) =>
    v
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
  );

const schema = z.object({
  LINE_CHANNEL_ACCESS_TOKEN: z.string().min(1),
  LINE_CHANNEL_SECRET: z.string().min(1),
  LIFF_ID: z.string().default(''),
  // The LINE Login channel id backing the LIFF app — required to verify a
  // LIFF ID token via LINE's /oauth2/v2.1/verify endpoint. Different from
  // LINE_CHANNEL_ACCESS_TOKEN, which belongs to the Messaging API channel.
  LIFF_CHANNEL_ID: z.string().default(''),

  DATABASE_URL: z.string().min(1),

  PORT: z.coerce.number().int().positive().default(3000),
  PUBLIC_BASE_URL: z.string().default('http://localhost:3000'),
  TZ: z.string().default('Asia/Bangkok'),

  PUSH_MONTHLY_QUOTA: z.coerce.number().int().positive().default(500),
  PUSH_RESERVE_THRESHOLD: z.coerce.number().int().nonnegative().default(60),
  DIGEST_MORNING_HOUR: z.coerce.number().int().min(0).max(23).default(7),
  DIGEST_EVENING_HOUR: z.coerce.number().int().min(0).max(23).default(20),

  AI_ENABLED: bool,
  OPENAI_API_KEY: z.string().default(''),
  OPENAI_TEXT_MODEL: z.string().default('gpt-5-mini'),
  OPENAI_VISION_MODEL: z.string().default('gpt-4o-mini'),
  AI_MODULES_DISABLED: csv,
});

export type Config = z.infer<typeof schema> & {
  /** AI is only actually usable when the switch is on AND a key is present. */
  aiUsable: boolean;
};

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = schema.safeParse(env);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  ${i.path.join('.')}: ${i.message}`)
      .join('\n');
    throw new Error(`Invalid environment configuration:\n${issues}`);
  }
  const cfg = parsed.data;
  return { ...cfg, aiUsable: cfg.AI_ENABLED && cfg.OPENAI_API_KEY.length > 0 };
}

/** Per-module AI opt-out, so e.g. medication text never leaves the server. */
export function aiEnabledForModule(cfg: Config, moduleName: string): boolean {
  return cfg.aiUsable && !cfg.AI_MODULES_DISABLED.includes(moduleName);
}
