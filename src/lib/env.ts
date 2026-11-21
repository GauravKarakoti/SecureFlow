import { z } from "zod";
import {
  DEFAULT_SECRET_VARS,
  resolveFileSecrets,
  resolveSecretValue,
  trimTrailingNewline,
} from "./secret-config";

export const SECRET_ENV_VARS = new Set([
  ...DEFAULT_SECRET_VARS,
  ...DEFAULT_SECRET_VARS.map((v) => `${v}_FILE`),
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

const positiveIntStringSchema = (label: string) =>
  z
    .string()
    .optional()
    .refine(
      (val) => {
        if (val === undefined || val.trim() === "") return true;
        const n = Number(val.trim());
        return Number.isInteger(n) && n > 0;
      },
      { message: `${label} must be a positive integer (days)` },
    );

const envSchema = z
  .object({
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

    NODE_ENV: z.string().optional(),
    GITHUB_API_URL: z
      .string()
      .optional()
      .transform((val) => (val && val.trim() !== "" ? val.trim() : "https://api.github.com"))
      .pipe(z.string().url("GITHUB_API_URL must be a valid URL")),
    GITHUB_WEB_URL: z
      .string()
      .optional()
      .transform((val) => (val && val.trim() !== "" ? val.trim() : undefined))
      .pipe(z.string().url("GITHUB_WEB_URL must be a valid URL").optional()),

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

    AI_PROVIDER: z
      .string()
      .optional()
      .refine(
        (val) => {
          if (!val || val.trim() === "") return true;
          const normalized = val.toLowerCase().trim();
          return ["groq", "ollama", "vllm", "openai", "custom"].includes(normalized);
        },
        {
          message: "AI_PROVIDER must be one of: groq, ollama, vllm, openai, custom",
        },
      ),
    AI_MODEL: z
      .string()
      .optional()
      .refine((val) => val === undefined || val.trim().length > 0, {
        message: "AI_MODEL cannot be empty if specified",
      }),
    AI_MODEL_NAME: z.string().optional(),
    AI_BASE_URL: z
      .string()
      .optional()
      .refine(
        (val) => {
          if (!val || val.trim() === "") return true;
          try {
            const parsed = new URL(val.trim());
            return parsed.protocol === "http:" || parsed.protocol === "https:";
          } catch {
            return false;
          }
        },
        {
          message: "AI_BASE_URL must be a valid HTTP or HTTPS URL",
        },
      ),
    REMEDIATION_PROVIDER: z.string().optional(),
    REMEDIATION_MODEL: z.string().optional(),
    REMEDIATION_BASE_URL: z.string().optional(),

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

    // Finding age targets (days). Must be positive integers when set.
    FINDING_AGE_TARGET_CRITICAL: positiveIntStringSchema("FINDING_AGE_TARGET_CRITICAL"),
    FINDING_AGE_TARGET_HIGH: positiveIntStringSchema("FINDING_AGE_TARGET_HIGH"),
    FINDING_AGE_TARGET_MEDIUM: positiveIntStringSchema("FINDING_AGE_TARGET_MEDIUM"),
    FINDING_AGE_TARGET_LOW: positiveIntStringSchema("FINDING_AGE_TARGET_LOW"),
    FINDING_AGE_TARGET_INFO: positiveIntStringSchema("FINDING_AGE_TARGET_INFO"),

    // Weekly Security Digest & Mailing (Brevo / SMTP) (#1788)
    BREVO_API_KEY: z.string().optional(),
    BREVO_SENDER_EMAIL: z.string().optional(),
    BREVO_SENDER_NAME: z.string().optional(),
    WEEKLY_DIGEST_SCHEDULE: z.string().optional(),
    SMTP_HOST: z.string().optional(),
    SMTP_PORT: z.string().optional(),
    SMTP_USER: z.string().optional(),
    SMTP_PASS: z.string().optional(),
    SMTP_FROM: z.string().optional(),
    SMTP_SECURE: z.string().optional(),

    // File-based secret variants (#1893)
    DATABASE_URL_FILE: z.string().optional(),
    DATABASE_POOL_URL_FILE: z.string().optional(),
    GROQ_API_KEY_FILE: z.string().optional(),
    GITHUB_WEBHOOK_SECRET_FILE: z.string().optional(),
    GITHUB_PRIVATE_KEY_FILE: z.string().optional(),
    GITHUB_CLIENT_SECRET_FILE: z.string().optional(),
    AUTH_SECRET_FILE: z.string().optional(),
    ARMORIQ_API_KEY_FILE: z.string().optional(),
    ARMORIQ_PROOF_SIGNING_KEY_FILE: z.string().optional(),
    UPSTASH_REDIS_REST_TOKEN_FILE: z.string().optional(),
    ELEVENLABS_API_KEY_FILE: z.string().optional(),
    BREVO_API_KEY_FILE: z.string().optional(),
    SMTP_PASS_FILE: z.string().optional(),
    REDIS_URL_FILE: z.string().optional(),
  })
  .superRefine((data, ctx) => {
    const isProduction = (data.NODE_ENV ?? process.env.NODE_ENV) === "production";
    if (isProduction) {
      if (data.GITHUB_API_URL) {
        try {
          const u = new URL(data.GITHUB_API_URL);
          if (u.protocol !== "https:") {
            ctx.addIssue({
              code: z.ZodIssueCode.custom,
              path: ["GITHUB_API_URL"],
              message: "GITHUB_API_URL must use HTTPS in production",
            });
          }
        } catch {
          // Handled by URL schema
        }
      }

      if (data.GITHUB_WEB_URL) {
        try {
          const u = new URL(data.GITHUB_WEB_URL);
          if (u.protocol !== "https:") {
            ctx.addIssue({
              code: z.ZodIssueCode.custom,
              path: ["GITHUB_WEB_URL"],
              message: "GITHUB_WEB_URL must use HTTPS in production",
            });
          }
        } catch {
          // Handled by URL schema
        }
      }
    }
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
      const isSecret = SECRET_ENV_VARS.has(varName) || varName.endsWith("_FILE");

      if (isSecret) {
        return `  - ${varName}: ${issue.message} [value redacted]`;
      }

      return `  - ${varName}: ${issue.message}`;
    })
    .join("\n");
}

export function validateEnv(source: Record<string, string | undefined> = process.env): Env {
  // Resolve file-based secrets (<NAME>_FILE -> <NAME>) before validating schema (#1893)
  resolveFileSecrets(source, {
    mutateProcessEnv: source === process.env,
  });

  const result = envSchema.safeParse(source);

  if (!result.success) {
    const errorDetails = formatEnvErrors(result.error.issues, source);
    const message = `❌ Invalid environment configuration. The server failed to start because the following environment variables are missing or malformed:\n${errorDetails}\n\nPlease check your .env file or environment settings.`;

    // Ensure error output never leaks secrets
    throw new Error(message);
  }

  return result.data;
}

export { DEFAULT_SECRET_VARS, resolveFileSecrets, resolveSecretValue, trimTrailingNewline };

const isTest = process.env.NODE_ENV === "test" || process.env.VITEST === "true";

export const env: Env = isTest ? (process.env as unknown as Env) : validateEnv();
