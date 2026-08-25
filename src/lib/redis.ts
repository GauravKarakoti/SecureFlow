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

/** How often a write may trigger a sweep of expired entries. */
const MEMORY_STORE_SWEEP_INTERVAL_MS = 30_000;

// Basic in-memory fallback for rate limiting if Redis isn't configured
const memoryStore = new Map<string, { count: number; resetAt: number }>();

let lastSweepAt = 0;

/**
 * Drop every entry whose window has already closed.
 *
 * Called opportunistically from the write path rather than from a `setInterval`,
 * so the module never holds a timer that would keep a serverless function or a
 * test runner alive.
 */
function sweepExpiredEntries(now: number): void {
  for (const [key, record] of memoryStore) {
    if (record.resetAt <= now) {
      memoryStore.delete(key);
    }
  }
  lastSweepAt = now;
}

/**
 * Make room for a new key once the cap is reached.
 *
 * A sweep usually frees space on its own. If every entry is still live — which
 * means the instance really is tracking more distinct clients than the cap — the
 * entries closest to expiry are evicted first, since they are the ones whose loss
 * costs the least enforcement accuracy.
 */
function evictForCapacity(now: number): void {
  if (memoryStore.size < MAX_MEMORY_STORE_ENTRIES) return;

  sweepExpiredEntries(now);
  if (memoryStore.size < MAX_MEMORY_STORE_ENTRIES) return;

  const soonestFirst = [...memoryStore.entries()].sort((a, b) => a[1].resetAt - b[1].resetAt);
  const overflow = memoryStore.size - MAX_MEMORY_STORE_ENTRIES + 1;
  for (let i = 0; i < overflow; i++) {
    memoryStore.delete(soonestFirst[i][0]);
  }
}

/** Test seam: current number of tracked keys in the in-memory fallback. */
export function getMemoryStoreSize(): number {
  return memoryStore.size;
}

/** Test seam: drop all in-memory state. */
export function resetMemoryStore(): void {
  memoryStore.clear();
  lastSweepAt = 0;
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

/** Apply the counter to the in-memory map, sweeping and capping as a side effect. */
function checkMemoryRateLimit(
  key: string,
  limit: number,
  windowSeconds: number,
  now: number
): RateLimitResult {
  const record = memoryStore.get(key);

  if (!record || record.resetAt <= now) {
    // Amortised cleanup: expired entries are reclaimed on the write path so the
    // map cannot grow monotonically the way it did before.
    if (now - lastSweepAt >= MEMORY_STORE_SWEEP_INTERVAL_MS) {
      sweepExpiredEntries(now);
    }
    evictForCapacity(now);

    const resetAt = now + windowSeconds * 1000;
    memoryStore.set(key, { count: 1, resetAt });
    return { allowed: true, limit, remaining: Math.max(0, limit - 1), resetAt, degraded: false };
  }

  if (record.count < limit) {
    record.count += 1;
    return {
      allowed: true,
      limit,
      remaining: Math.max(0, limit - record.count),
      resetAt: record.resetAt,
      degraded: false,
    };
  }

  return { allowed: false, limit, remaining: 0, resetAt: record.resetAt, degraded: false };
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
  options?: RateLimitOptions | FallbackStrategy
): Promise<RateLimitResult> {
  const now = Date.now();
  const fallbackStrategy: FallbackStrategy =
    typeof options === 'string' ? options : (options?.fallbackStrategy ?? 'fail-open');
  const timeoutMs = typeof options === 'object' ? (options?.timeoutMs ?? 1000) : 1000;

  if (!redis) {
    return checkMemoryRateLimit(key, limit, windowSeconds, now);
  }

  try {
    const incrementTask = (async (): Promise<RateLimitResult> => {
      const current = await redis.incr(key);

      // A fresh counter always gets a TTL. Without this the key would live
      // forever in Redis and the client would be permanently blocked once it
      // first crossed the limit.
      let ttlMs = windowSeconds * 1000;
      if (current === 1) {
        await redis.expire(key, windowSeconds);
      } else if (typeof redis.pttl === 'function') {
        const pttl = await redis.pttl(key);
        if (typeof pttl === 'number' && pttl > 0) {
          ttlMs = pttl;
        } else if (typeof pttl === 'number' && pttl < 0) {
          // -1 means the key exists with no expiry, which can happen if a
          // previous process died between INCR and EXPIRE. Re-arm it rather
          // than leaving a counter that never resets.
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
    })();

    return await withTimeout(incrementTask, timeoutMs);
  } catch (error) {
    console.error('Redis error or timeout during rate limiting:', error);

    // The counter is unknown, so the reported window is a best guess. `degraded`
    // tells the caller not to advertise it as authoritative.
    const allowed = fallbackStrategy !== 'fail-closed';
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
  options?: RateLimitOptions | FallbackStrategy
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
  }
}

