import Redis from 'ioredis';

const globalForRedis = globalThis as unknown as {
  redis: Redis | undefined;
};

// Use an in-memory fallback if REDIS_URL is not provided (useful for local dev without Docker)
let redisInstance: Redis | null = null;

if (process.env.REDIS_URL && process.env.REDIS_URL.trim() !== '') {
  redisInstance =
    globalForRedis.redis ??
    new Redis(process.env.REDIS_URL, {
      retryStrategy(times) {
        const delay = Math.min(times * 50, 2000);
        return delay; // Reconnect after a slight delay
      },
      maxRetriesPerRequest: 3,
    });
    
  if (process.env.NODE_ENV !== 'production') globalForRedis.redis = redisInstance;
} else {
  console.warn('⚠️ REDIS_URL is not set. Rate limiting will fall back to an in-memory Map (not suitable for production multi-instance).');
}

export const redis = redisInstance;

export type FallbackStrategy = 'fail-open' | 'fail-closed';

export interface RateLimitOptions {
  fallbackStrategy?: FallbackStrategy;
  timeoutMs?: number;
}

// Basic in-memory fallback for rate limiting if Redis isn't configured
const memoryStore = new Map<string, { count: number; resetAt: number }>();

function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`Redis operation timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    promise
      .then((res) => {
        clearTimeout(timer);
        resolve(res);
      })
      .catch((err) => {
        clearTimeout(timer);
        reject(err);
      });
  });
}

export async function checkRateLimit(
  key: string,
  limit: number,
  windowSeconds: number,
  options?: RateLimitOptions | FallbackStrategy
): Promise<boolean> {
  const now = Date.now();
  const fallbackStrategy: FallbackStrategy =
    typeof options === 'string' ? options : (options?.fallbackStrategy ?? 'fail-open');
  const timeoutMs = typeof options === 'object' ? (options?.timeoutMs ?? 1000) : 1000;

  if (redis) {
    try {
      const incrementTask = (async () => {
        const current = await redis.incr(key);
        if (current === 1) {
          await redis.expire(key, windowSeconds);
        }
        return current <= limit;
      })();

      return await withTimeout(incrementTask, timeoutMs);
    } catch (error) {
      console.error('Redis error or timeout during rate limiting:', error);
      if (fallbackStrategy === 'fail-closed') {
        return false;
      }
      // Fail open to avoid blocking legitimate traffic if Redis goes down or times out
      return true;
    }
  } else {
    // In-memory fallback logic
    const record = memoryStore.get(key);
    if (!record || record.resetAt < now) {
      memoryStore.set(key, { count: 1, resetAt: now + windowSeconds * 1000 });
      return true;
    }

    if (record.count < limit) {
      record.count += 1;
      return true;
    }

    return false;
  }
}
