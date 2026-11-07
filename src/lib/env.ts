import { z } from "zod";

const SECRET_ENV_VARS = new Set([
  "DATABASE_URL",
  "DATABASE_POOL_URL",
  "GROQ_API_KEY",
  "GITHUB_WEBHOOK_SECRET",
  "GITHUB_PRIVATE_KEY",
  "GITHUB_CLIENT_SECRET",
  "AUTH_SECRET",
  "ARMORIQ_API_KEY",
  "UPSTASH_REDIS_REST_TOKEN",
  "ELEVENLABS_API_KEY",
]);

/**
 * Validates a PEM private key format with standard header and footer markers
 * and basic structure checks to catch corrupted or broken newlines early.
 */
const privateKeySchema = z
  .string()
  .min(1, "GITHUB_PRIVATE_KEY is required")
  .refine(
    (val) => {
      // Normalise literal \n strings if pasted into single-line env var
      const normalized = val.replace(/\\n/g, "\n").trim();
      // Must contain begin and end RSA/OPENSSH/PRIVATE KEY markers
      const hasBegin = /-----BEGIN (?:[A-Z0-9_-]+ )?PRIVATE KEY-----/.test(normalized);
      const hasEnd = /-----END (?:[A-Z0-9_-]+ )?PRIVATE KEY-----/.test(normalized);
      return hasBegin && hasEnd;
    },
    {
      message: "Invalid private key format: must contain valid BEGIN and END PRIVATE KEY markers",
    },
  );

const envSchema = z.object({
  // Required
  DATABASE_URL: z.string().min(1, "DATABASE_URL is required"),
  DATABASE_POOL_URL: z.string().min(1, "DATABASE_POOL_URL is required"),
  GROQ_API_KEY: z.string().min(1, "GROQ_API_KEY is required"),

  GITHUB_APP_ID: z.string().min(1, "GITHUB_APP_ID is required"),
  GITHUB_WEBHOOK_SECRET: z.string().min(1, "GITHUB_WEBHOOK_SECRET is required"),
  GITHUB_PRIVATE_KEY: privateKeySchema,
  GITHUB_CLIENT_ID: z.string().min(1, "GITHUB_CLIENT_ID is required"),
  GITHUB_CLIENT_SECRET: z.string().min(1, "GITHUB_CLIENT_SECRET is required"),

  AUTH_SECRET: z.string().min(1, "AUTH_SECRET is required"),
  AUTH_URL: z.string().url("AUTH_URL must be a valid URL"),
  NEXT_PUBLIC_APP_URL: z.string().url("NEXT_PUBLIC_APP_URL must be a valid URL"),

  // Optional
  DB_POOL_MAX: z.string().optional(),
  GITHUB_WEBHOOK_MAX_BYTES: z.string().optional(),
  WEBHOOK_MAX_BYTES: z.string().optional(),
  WEBHOOK_ALLOW_UNBOUND_LEGACY_SIGNATURES: z.string().optional(),
  GITHUB_APP_URL: z.string().url().optional(),
  ARMORIQ_API_KEY: z.string().optional(),
  USER_ID: z.string().optional(),
  AGENT_ID: z.string().optional(),

  CSP_REPORT_ONLY: z.string().optional(),
  CSP_REPORT_URI: z.string().optional(),

  REDIS_URL: z.string().url().optional(),
  UPSTASH_REDIS_REST_URL: z.string().url().optional(),
  UPSTASH_REDIS_REST_TOKEN: z.string().optional(),

  TRUSTED_PROXY_HOP_COUNT: z
    .string()
    .optional()
    .refine(
      (val) => {
        if (val === undefined || val.trim() === "") return true;
        const num = Number(val.trim());
        return Number.isInteger(num) && num >= 0 && num <= 100;
      },
      {
        message: "TRUSTED_PROXY_HOP_COUNT must be a non-negative integer (between 0 and 100)",
      },
    ),
  TRUSTED_PROXY_IPS: z.string().optional(),

  GROQ_MODEL: z.string().optional(),

  DIFF_CHUNK_MAX_CHARS: z.string().optional(),
  DIFF_FILE_MAX_CHARS: z.string().optional(),
  FINDING_SNIPPET_REDACT_DAYS: z.string().optional(),
  WEBHOOK_EVENT_RETENTION_DAYS: z.string().optional(),
  SCAN_RESULT_RETENTION_DAYS: z.string().optional(),
  AUDIT_LOG_RETENTION_DAYS: z.string().optional(),
  DATA_RETENTION_DAYS: z.string().optional(),
  LOG_LEVEL: z.string().optional(),

  OUTBOUND_WEBHOOK_TIMEOUT_MS: z.string().optional(),
  OUTBOUND_WEBHOOK_MAX_RESPONSE_BYTES: z.string().optional(),
  OUTBOUND_WEBHOOK_ALLOWED_HOSTS: z.string().optional(),
  OUTBOUND_WEBHOOK_ALLOW_INSECURE_HTTP: z.string().optional(),
  OUTBOUND_WEBHOOK_ALLOW_PRIVATE_NETWORKS: z.string().optional(),
  ELEVENLABS_API_KEY: z.string().optional(),
  ELEVENLABS_VOICE_ID_DEFAULT: z.string().optional(),
  ELEVENLABS_VOICE_ID_ALERT: z.string().optional(),
  ELEVENLABS_VOICE_ID_HEIST: z.string().optional(),
  ELEVENLABS_MODEL_ID: z.string().optional(),
  AUDIO_CACHE_TTL_SECONDS: z.string().optional(),
  SCAN_CACHE_TTL_SECONDS: z.string().optional(),
});

export type Env = z.infer<typeof envSchema>;

/**
 * Format validation issues into a human-readable list without ever printing secret values.
 */
export function formatEnvErrors(
  issues: z.ZodIssue[],
  source: Record<string, string | undefined>,
): string {
  return issues
    .map((issue) => {
      const varName = issue.path.join(".");
      const isSecret = SECRET_ENV_VARS.has(varName);

      if (isSecret) {
        return `  - ${varName}: ${issue.message} [value redacted]`;
      }

      return `  - ${varName}: ${issue.message}`;
    })
    .join("\n");
}

export function validateEnv(source: Record<string, string | undefined> = process.env): Env {
  const result = envSchema.safeParse(source);

  if (!result.success) {
    const errorDetails = formatEnvErrors(result.error.issues, source);
    const message = `❌ Invalid environment configuration. The server failed to start because the following environment variables are missing or malformed:\n${errorDetails}\n\nPlease check your .env file or environment settings.`;

    // Ensure error output never leaks secrets
    throw new Error(message);
  }

  return result.data;
}

const isTest = process.env.NODE_ENV === "test" || process.env.VITEST === "true";

export const env: Env = isTest ? (process.env as unknown as Env) : validateEnv();
