import Redis from "ioredis";
import { resolveQueueRedisUrl } from "@/lib/redis-config";

const redisOptions = {
  maxRetriesPerRequest: null,
  enableReadyCheck: false,
};

// Use a singleton pattern to avoid multiple connections in Next.js development.
//
// Keyed `queueRedis`: this module and the rate-limit client in
// `src/lib/redis.ts` both used `globalThis.redis`, but the two clients are
// configured differently on purpose — BullMQ needs `maxRetriesPerRequest: null`
// (a Worker throws on any other value), the rate limiter wants a bounded retry
// count. Sharing one key meant whichever module loaded first handed its client
// to the other.
const globalForRedis = global as unknown as { queueRedis: any };

export const redis =
  globalForRedis.queueRedis ||
  (process.env.NEXT_PUBLIC_MOCK_DB === "true"
    ? ({
        on: () => {},
        info: async () => "redis_version:6.2.6",
        get: async () => null,
        set: async () => "OK",
        del: async () => 1,
      } as any)
    : // Throws in production when REDIS_URL is missing or malformed, instead of
      // quietly connecting to localhost. See `@/lib/redis-config`.
      new Redis(resolveQueueRedisUrl(), redisOptions));

if (process.env.NODE_ENV !== "production") {
  globalForRedis.queueRedis = redis;
}

/**
 * Gracefully close Queue Redis connection if active.
 */
export async function closeQueueRedis(): Promise<void> {
  if (redis && typeof redis.quit === "function") {
    try {
      await redis.quit();
    } catch {
      if (typeof redis.disconnect === "function") {
        redis.disconnect();
      }
    }
    // Clear the dev singleton so a hot-reloaded module does not reuse the
    // closed client.
    globalForRedis.queueRedis = undefined;
  }
}
