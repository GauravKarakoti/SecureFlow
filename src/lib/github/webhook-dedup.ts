import { redis } from "@/lib/redis";

/**
 * 24 hours in seconds (86,400s).
 * Delivery IDs are kept in Redis for 24 hours to deduplicate webhook replays.
 */
export const WEBHOOK_DELIVERY_TTL_SECONDS = 86_400;

export const WEBHOOK_DELIVERY_KEY_PREFIX = "webhook:delivery:";

export type RedisClientLike = {
  set: (...args: unknown[]) => Promise<unknown>;
};

export interface DedupeResult {
  isDuplicate: boolean;
  recorded: boolean;
}

/**
 * Derives the Redis key used to track webhook delivery IDs.
 */
export function webhookDeliveryKey(deliveryId: string): string {
  return `${WEBHOOK_DELIVERY_KEY_PREFIX}${deliveryId}`;
}

/**
 * Attempts to record a webhook delivery ID in Redis with a 24-hour TTL using
 * an atomic set-if-absent command (`SET key 1 EX 86400 NX`).
 *
 * Returns:
 * - `{ isDuplicate: true, recorded: false }` if the delivery was already recorded
 * - `{ isDuplicate: false, recorded: true }` if this is a new delivery
 * - `{ isDuplicate: false, recorded: false }` if Redis is unavailable (fail-open)
 */
export async function recordWebhookDelivery(
  deliveryId: string,
  client?: RedisClientLike | null,
): Promise<DedupeResult> {
  if (!deliveryId || typeof deliveryId !== "string" || !deliveryId.trim()) {
    return { isDuplicate: false, recorded: false };
  }

  const redisClient = client !== undefined ? client : redis;
  if (!redisClient || typeof redisClient.set !== "function") {
    return { isDuplicate: false, recorded: false };
  }

  const key = webhookDeliveryKey(deliveryId.trim());

  try {
    const result = await redisClient.set(key, "1", "EX", WEBHOOK_DELIVERY_TTL_SECONDS, "NX");

    // In Redis, SET ... NX returns "OK" when set, or null if key already existed
    const isNew = result === "OK" || result === true;
    return {
      isDuplicate: !isNew,
      recorded: isNew,
    };
  } catch (error) {
    console.warn(
      `[WEBHOOK_DEDUPE] Redis error checking delivery ${deliveryId}; processing normally.`,
      error,
    );
    return { isDuplicate: false, recorded: false };
  }
}

/**
 * Check whether a webhook delivery is a duplicate.
 * Returns true if duplicate, false if new or if Redis is unavailable.
 */
export async function isDuplicateDelivery(
  deliveryId: string,
  client?: RedisClientLike | null,
): Promise<boolean> {
  const res = await recordWebhookDelivery(deliveryId, client);
  return res.isDuplicate;
}
