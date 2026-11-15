import { redis } from "@/lib/redis";
import { createLogger } from "@/lib/logger";

const log = createLogger({ context: { component: "webhook-secret-store" } });

/**
 * Default grace period for a previous webhook secret: 24 hours in seconds (86,400s).
 * Matches GitHub's maximum retry window for webhooks.
 */
export const DEFAULT_WEBHOOK_SECRET_GRACE_PERIOD_SECONDS = 86_400;

export const WEBHOOK_SECRET_CURRENT_KEY = "webhook:github:current_secret";
export const WEBHOOK_SECRET_PREVIOUS_KEY = "webhook:github:previous_secret";

export type RedisLike = {
  get: (key: string) => Promise<string | null>;
  set: (...args: unknown[]) => Promise<unknown>;
  del?: (...args: string[]) => Promise<unknown>;
};

// In-memory fallback if Redis is not configured
let inMemoryCurrentSecret: string | null = null;
let inMemoryPreviousSecret: { secret: string; expiresAt: number } | null = null;

export interface ResolvedWebhookSecrets {
  current: string;
  previous: string | null;
}

/**
 * Resolves current and previous webhook secrets without maintaining two separate env vars.
 *
 * 1. If `configuredSecret` contains comma-separated values (e.g. "new_sec,old_sec"),
 *    the first value is used as current and the second as previous.
 * 2. Otherwise, compares `configuredSecret` with the recorded current secret in Redis (or in-memory).
 *    If a rotation is detected (configuredSecret differs from recorded current):
 *    - The previous active secret is preserved under `webhook:github:previous_secret` with a 24h grace-period TTL.
 *    - The new secret is recorded under `webhook:github:current_secret`.
 * 3. Returns `{ current, previous }`.
 */
export async function resolveWebhookSecrets(
  configuredSecret?: string | null,
  client?: RedisLike | null,
  gracePeriodSeconds: number = DEFAULT_WEBHOOK_SECRET_GRACE_PERIOD_SECONDS,
): Promise<ResolvedWebhookSecrets> {
  const secretStr = configuredSecret?.trim() ?? "";
  if (!secretStr) {
    return { current: "", previous: null };
  }

  // 1. Support comma-separated secret list if an operator pins multiple secrets in GITHUB_WEBHOOK_SECRET
  if (secretStr.includes(",")) {
    const parts = secretStr
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    return {
      current: parts[0] ?? "",
      previous: parts.length > 1 ? parts[1] : null,
    };
  }

  const redisClient = client !== undefined ? client : redis;

  // 2. Redis-backed grace period store
  if (
    redisClient &&
    typeof redisClient.get === "function" &&
    typeof redisClient.set === "function"
  ) {
    try {
      const recordedCurrent = await redisClient.get(WEBHOOK_SECRET_CURRENT_KEY);

      if (!recordedCurrent) {
        // First run or initial secret setup
        await redisClient.set(WEBHOOK_SECRET_CURRENT_KEY, secretStr);
        const previous = await redisClient.get(WEBHOOK_SECRET_PREVIOUS_KEY);
        return { current: secretStr, previous: previous ?? null };
      }

      if (recordedCurrent !== secretStr) {
        // Rotation detected! Move old secret to previous with grace period TTL
        await redisClient.set(
          WEBHOOK_SECRET_PREVIOUS_KEY,
          recordedCurrent,
          "EX",
          gracePeriodSeconds,
        );
        await redisClient.set(WEBHOOK_SECRET_CURRENT_KEY, secretStr);
        log.info(
          "[WEBHOOK_SECRET_STORE] Webhook secret rotation detected; previous secret cached for grace period",
          { gracePeriodSeconds },
        );
        return { current: secretStr, previous: recordedCurrent };
      }

      // No rotation; retrieve active previous secret if within grace period
      const previous = await redisClient.get(WEBHOOK_SECRET_PREVIOUS_KEY);
      return { current: secretStr, previous: previous ?? null };
    } catch (err) {
      log.warn(
        "[WEBHOOK_SECRET_STORE] Redis error resolving webhook secrets; falling back to memory store",
        { error: err },
      );
    }
  }

  // 3. In-memory fallback
  const now = Date.now();
  if (!inMemoryCurrentSecret) {
    inMemoryCurrentSecret = secretStr;
    const prev =
      inMemoryPreviousSecret && inMemoryPreviousSecret.expiresAt > now
        ? inMemoryPreviousSecret.secret
        : null;
    return { current: secretStr, previous: prev };
  }

  if (inMemoryCurrentSecret !== secretStr) {
    inMemoryPreviousSecret = {
      secret: inMemoryCurrentSecret,
      expiresAt: now + gracePeriodSeconds * 1000,
    };
    inMemoryCurrentSecret = secretStr;
    log.info(
      "[WEBHOOK_SECRET_STORE] In-memory secret rotation detected; previous secret cached for grace period",
      { gracePeriodSeconds },
    );
    return { current: secretStr, previous: inMemoryPreviousSecret.secret };
  }

  const prev =
    inMemoryPreviousSecret && inMemoryPreviousSecret.expiresAt > now
      ? inMemoryPreviousSecret.secret
      : null;

  return { current: secretStr, previous: prev };
}

/**
 * Programmatically records a secret rotation with a grace period.
 */
export async function recordWebhookSecretRotation(
  newSecret: string,
  oldSecret: string,
  client?: RedisLike | null,
  gracePeriodSeconds: number = DEFAULT_WEBHOOK_SECRET_GRACE_PERIOD_SECONDS,
): Promise<void> {
  const redisClient = client !== undefined ? client : redis;
  if (redisClient && typeof redisClient.set === "function") {
    try {
      await redisClient.set(WEBHOOK_SECRET_PREVIOUS_KEY, oldSecret, "EX", gracePeriodSeconds);
      await redisClient.set(WEBHOOK_SECRET_CURRENT_KEY, newSecret);
    } catch (err) {
      log.warn("[WEBHOOK_SECRET_STORE] Failed to record secret rotation in Redis", { error: err });
    }
  }

  inMemoryCurrentSecret = newSecret;
  inMemoryPreviousSecret = {
    secret: oldSecret,
    expiresAt: Date.now() + gracePeriodSeconds * 1000,
  };
}

/**
 * Resets the in-memory store (used for unit testing).
 */
export function resetInMemoryWebhookSecretStore(): void {
  inMemoryCurrentSecret = null;
  inMemoryPreviousSecret = null;
}
