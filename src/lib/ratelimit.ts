import { Ratelimit } from "@upstash/ratelimit";
import { Redis } from "@upstash/redis";

const redisUrl = process.env.UPSTASH_REDIS_REST_URL;
const redisToken = process.env.UPSTASH_REDIS_REST_TOKEN;

// Default to a no-op limiter if Upstash credentials are missing (e.g. local dev)
export const ratelimit = (redisUrl && redisToken)
  ? new Ratelimit({
      redis: Redis.fromEnv(),
      limiter: Ratelimit.slidingWindow(20, "1 m"),
      analytics: true,
    })
  : ({
      limit: async () => ({ success: true }),
    } as any);
