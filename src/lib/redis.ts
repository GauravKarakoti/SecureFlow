import Redis from "ioredis";
import { CircuitBreaker } from "./utils/circuit-breaker";
import { TokenBucketRateLimiter } from "./rate-limit/token-bucket";

// Not the same key as the queue client in `src/lib/queue/redis.ts`, which is
// configured for BullMQ (see the note there).
const globalForRedis = globalThis as unknown as {
  rateLimitRedis: Redis | undefined;
};

export const redisCircuitBreaker = new CircuitBreaker({
  failureThreshold: 5,
  resetTimeoutMs: 10000, // 10 seconds
});

// Use an in-memory fallback if REDIS_URL is not provided (useful for local dev without Docker)
let redisInstance: Redis | null = null;

if (process.env.REDIS_URL && process.env.REDIS_URL.trim() !== "") {
  redisInstance =
    globalForRedis.rateLimitRedis ??
    new Redis(process.env.REDIS_URL, {
      retryStrategy(times) {
        const delay = Math.min(times * 50, 2000);
        return delay; // Reconnect after a slight delay
      },
      maxRetriesPerRequest: 3,
    });

  if (process.env.NODE_ENV !== "production") globalForRedis.rateLimitRedis = redisInstance;
} else {
  console.warn(
    "⚠️ REDIS_URL is not set. Rate limiting will fall back to an in-memory Map (not suitable for production multi-instance).",
  );
}

export const redis = redisInstance;

export type FallbackStrategy = "fail-open" | "fail-closed";

export interface RateLimitOptions {
  fallbackStrategy?: FallbackStrategy;
  timeoutMs?: number;
}

/** Full outcome of a rate-limit check, enough to build the standard response headers. */
export interface RateLimitResult {
  /** Whether the request may proceed. */
  allowed: boolean;
  /** The ceiling that was applied. */
  limit: number;
  /** Requests still available in the current window; never negative. */
  remaining: number;
  /** Epoch milliseconds at which the current window rolls over. */
  resetAt: number;
  /**
   * True when the decision came from the fallback strategy rather than from a
   * real counter (Redis was unreachable or timed out). Callers use this to avoid
   * advertising header values they cannot actually stand behind.
   */
  degraded: boolean;
}

/**
 * Upper bound on distinct keys held by the in-memory fallback.
 *
 * Keys are `rate-limit:<prefix>:<ip>` and the IP comes from client-controllable
 * proxy headers, so without a cap the map grows for the lifetime of the process.
 * 10k entries is far more than any single instance legitimately needs within one
 * window while staying trivial in memory terms.
 */
const MAX_MEMORY_STORE_ENTRIES = 10_000;

// Bounded O(1) Token Bucket fallback for rate limiting when Redis isn't configured or available
const memoryTokenBucket = new TokenBucketRateLimiter({
  maxKeys: MAX_MEMORY_STORE_ENTRIES,
});

/** Test seam: current number of tracked keys in the in-memory fallback. */
export function getMemoryStoreSize(): number {
  return memoryTokenBucket.size;
}

/** Test seam: drop all in-memory state. */
export function resetMemoryStore(): void {
  memoryTokenBucket.clear();
}

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

/** Apply O(1) token bucket rate limiting in memory with bounded LRU eviction. */
function checkMemoryRateLimit(
  key: string,
  limit: number,
  windowSeconds: number,
  now: number,
): RateLimitResult {
  const decision = memoryTokenBucket.consume(key, limit, windowSeconds, 1, now);
  return {
    allowed: decision.allowed,
    limit: decision.limit,
    remaining: decision.remaining,
    resetAt: decision.resetAt,
    degraded: decision.degraded,
  };
}

/**
 * Increment the counter for `key` and report the full window state.
 *
 * Prefer this over `checkRateLimit` when the caller wants to surface
 * `X-RateLimit-*` headers; `checkRateLimit` remains as the boolean shorthand.
 */
export async function checkRateLimitDetailed(
  key: string,
  limit: number,
  windowSeconds: number,
  options?: RateLimitOptions | FallbackStrategy,
): Promise<RateLimitResult> {
  const now = Date.now();
  const fallbackStrategy: FallbackStrategy =
    typeof options === "string" ? options : (options?.fallbackStrategy ?? "fail-open");
  const timeoutMs = typeof options === "object" ? (options?.timeoutMs ?? 1000) : 1000;

  if (!redis) {
    return checkMemoryRateLimit(key, limit, windowSeconds, now);
  }

  try {
    const incrementTask = async (): Promise<RateLimitResult> => {
      const pipeline = redis.pipeline();
      pipeline.incr(key);
      pipeline.expire(key, windowSeconds, "NX"); // Only set expiry if key has no TTL
      const results = await pipeline.exec();

      if (!results) {
        throw new Error("Redis pipeline execution returned null");
      }

      if (results[0]?.[0]) {
        throw results[0][0];
      }

      const current = (results[0][1] as number) ?? 1;

      // Retrieve the remaining TTL to maintain accurate X-RateLimit-Reset calculations
      let ttlMs = windowSeconds * 1000;
      if (typeof redis.pttl === "function") {
        const pttl = await redis.pttl(key);
        if (typeof pttl === "number" && pttl > 0) {
          ttlMs = pttl;
        } else if (typeof pttl === "number" && pttl < 0) {
          // -1 means the key exists with no expiry. Re-arm it rather than leaving
          // a counter that never resets.
          await redis.expire(key, windowSeconds);
        }
      }

      return {
        allowed: current <= limit,
        limit,
        remaining: Math.max(0, limit - current),
        resetAt: now + ttlMs,
        degraded: false,
      };
    };

    return await redisCircuitBreaker.execute(() => withTimeout(incrementTask(), timeoutMs));
  } catch (error: any) {
    if (error?.name !== "CircuitBreakerError") {
      console.error("Redis error or timeout during rate limiting:", error);
    }

    // The counter is unknown, so the reported window is a best guess. `degraded`
    // tells the caller not to advertise it as authoritative.
    const allowed = fallbackStrategy !== "fail-closed";
    return {
      allowed,
      limit,
      remaining: allowed ? limit : 0,
      resetAt: now + windowSeconds * 1000,
      degraded: true,
    };
  }
}

/**
 * Boolean shorthand for `checkRateLimitDetailed`.
 *
 * Kept with its original signature and semantics because it is used directly by
 * callers that only need an allow/deny decision.
 */
export async function checkRateLimit(
  key: string,
  limit: number,
  windowSeconds: number,
  options?: RateLimitOptions | FallbackStrategy,
): Promise<boolean> {
  const result = await checkRateLimitDetailed(key, limit, windowSeconds, options);
  return result.allowed;
}

/**
 * Gracefully close Redis connection if active.
 */
export async function closeRedis(): Promise<void> {
  if (redisInstance) {
    try {
      await redisInstance.quit();
    } catch {
      redisInstance.disconnect();
    }
    // Clear the dev singleton too: after an HMR reload the re-executed module
    // would otherwise hand out the closed client from globalThis, and every
    // command would reject with "Connection is closed".
    redisInstance = null;
    globalForRedis.rateLimitRedis = undefined;
  }
}
