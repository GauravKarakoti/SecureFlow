import { z } from "zod";

const envSchema = z.object({
  // Required
  DATABASE_URL: z.string().min(1),
  DATABASE_POOL_URL: z.string().min(1),
  GROQ_API_KEY: z.string().min(1),

  GITHUB_APP_ID: z.string().min(1),
  GITHUB_WEBHOOK_SECRET: z.string().min(1),
  GITHUB_PRIVATE_KEY: z.string().min(1),
  GITHUB_CLIENT_ID: z.string().min(1),
  GITHUB_CLIENT_SECRET: z.string().min(1),

  AUTH_SECRET: z.string().min(1),
  AUTH_URL: z.string().min(1),
  NEXT_PUBLIC_APP_URL: z.string().min(1),

  // Optional
  DB_POOL_MAX: z.string().optional(),
  GITHUB_WEBHOOK_MAX_BYTES: z.string().optional(),
  GITHUB_APP_URL: z.string().optional(),
  ARMORIQ_API_KEY: z.string().optional(),
  USER_ID: z.string().optional(),
  AGENT_ID: z.string().optional(),

  CSP_REPORT_ONLY: z.string().optional(),
  CSP_REPORT_URI: z.string().optional(),

  REDIS_URL: z.string().optional(),
  UPSTASH_REDIS_REST_URL: z.string().optional(),
  UPSTASH_REDIS_REST_TOKEN: z.string().optional(),

  TRUSTED_PROXY_HOP_COUNT: z.string().optional(),
  TRUSTED_PROXY_IPS: z.string().optional(),

  GROQ_MODEL: z.string().optional(),

  FINDING_SNIPPET_REDACT_DAYS: z.string().optional(),
  WEBHOOK_EVENT_RETENTION_DAYS: z.string().optional(),
  SCAN_RESULT_RETENTION_DAYS: z.string().optional(),
  AUDIT_LOG_RETENTION_DAYS: z.string().optional(),

  LOG_LEVEL: z.string().optional(),

  OUTBOUND_WEBHOOK_TIMEOUT_MS: z.string().optional(),
  OUTBOUND_WEBHOOK_MAX_RESPONSE_BYTES: z.string().optional(),
  OUTBOUND_WEBHOOK_ALLOWED_HOSTS: z.string().optional(),
  OUTBOUND_WEBHOOK_ALLOW_INSECURE_HTTP: z.string().optional(),
  OUTBOUND_WEBHOOK_ALLOW_PRIVATE_NETWORKS: z.string().optional(),
});

export type Env = z.infer<typeof envSchema>;

export function validateEnv(source: Record<string, string | undefined> = process.env): Env {
  const result = envSchema.safeParse(source);

  if (!result.success) {
    const errors = result.error.issues
      .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
      .join("\n");

    throw new Error(`Invalid environment variables:\n${errors}`);
  }

  return result.data;
}

const isTest = process.env.NODE_ENV === "test" || process.env.VITEST === "true";

export const env = isTest ? (process.env as unknown as Env) : validateEnv();
