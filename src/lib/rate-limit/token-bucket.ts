/**
 * O(1) Space Token Bucket Rate Limiter with Bounded LRU Eviction (#2072).
 *
 * Stores only two scalar numbers (`tokens` and `lastRefillAt`) per tracked key
 * and leverages JavaScript Map insertion-order semantics (`delete` + `set`) for
 * strict O(1) LRU promotion and eviction under bounded memory ceilings.
 */

export interface TokenBucketEntry {
  tokens: number;
  lastRefillAt: number;
  windowResetAt?: number | undefined;
}

export interface TokenBucketDecision {
  allowed: boolean;
  limit: number;
  remaining: number;
  resetAt: number;
  retryAfterSeconds: number;
  degraded: boolean;
}

export interface TokenBucketOptions {
  /** Maximum number of distinct client keys tracked concurrently (default: 10,000). */
  maxKeys?: number;
  /** Opportunistic sweep interval in ms for expired/idle buckets (default: 30,000). */
  sweepIntervalMs?: number;
}

export const DEFAULT_MAX_BUCKET_KEYS = 10_000;
const DEFAULT_SWEEP_INTERVAL_MS = 30_000;

export class TokenBucketRateLimiter {
  private readonly buckets = new Map<string, TokenBucketEntry>();
  private readonly maxKeys: number;
  private readonly sweepIntervalMs: number;
  private lastSweepAt = 0;

  constructor(options: TokenBucketOptions = {}) {
    this.maxKeys = Math.max(1, options.maxKeys ?? DEFAULT_MAX_BUCKET_KEYS);
    this.sweepIntervalMs = Math.max(1, options.sweepIntervalMs ?? DEFAULT_SWEEP_INTERVAL_MS);
  }

  /** Number of currently tracked client keys. */
  get size(): number {
    return this.buckets.size;
  }

  /** Clears all tracked token buckets. */
  clear(): void {
    this.buckets.clear();
    this.lastSweepAt = 0;
  }

  /** Inspects a bucket without mutating its token balance or LRU position. */
  peek(key: string): TokenBucketEntry | undefined {
    return this.buckets.get(key);
  }

  /**
   * Opportunistically drops buckets whose active window has expired.
   */
  sweepExpired(now: number): number {
    let removed = 0;
    for (const [k, entry] of this.buckets) {
      if ((entry.windowResetAt ?? entry.lastRefillAt) <= now) {
        this.buckets.delete(k);
        removed++;
      }
    }
    this.lastSweepAt = now;
    return removed;
  }

  /**
   * Atomically evaluates and consumes `cost` tokens for `key` using continuous
   * mathematical replenishment:
   *   tokens = min(capacity, lastTokens + (now - lastRefillAt) * refillRatePerMs)
   */
  consume(
    key: string,
    capacity: number,
    windowSeconds: number,
    cost = 1,
    now = Date.now(),
  ): TokenBucketDecision {
    const safeCapacity = Math.max(1, capacity);
    const safeWindowMs = Math.max(1, windowSeconds * 1000);
    const refillRatePerMs = safeCapacity / safeWindowMs;

    if (now - this.lastSweepAt >= this.sweepIntervalMs) {
      this.sweepExpired(now);
    }

    const existing = this.buckets.get(key);
    let currentTokens: number;
    let windowResetAt: number;

    if (!existing) {
      currentTokens = safeCapacity;
      windowResetAt = now + safeWindowMs;
    } else {
      const elapsedMs = Math.max(0, now - existing.lastRefillAt);
      currentTokens = Math.min(safeCapacity, existing.tokens + elapsedMs * refillRatePerMs);
      windowResetAt =
        currentTokens >= safeCapacity || (existing.windowResetAt ?? 0) <= now
          ? now + safeWindowMs
          : existing.windowResetAt!;
      // Promote to MRU tail in O(1)
      this.buckets.delete(key);
    }

    // Evict Least-Recently-Used (LRU) head in O(1) if adding a new key at capacity
    if (!existing && this.buckets.size >= this.maxKeys) {
      const lruKey = this.buckets.keys().next().value;
      if (lruKey !== undefined) {
        this.buckets.delete(lruKey);
      }
    }

    if (currentTokens >= cost) {
      const remainingTokens = currentTokens - cost;
      this.buckets.set(key, {
        tokens: remainingTokens,
        lastRefillAt: now,
        windowResetAt,
      });

      return {
        allowed: true,
        limit: safeCapacity,
        remaining: Math.floor(remainingTokens),
        resetAt: windowResetAt,
        retryAfterSeconds: 0,
        degraded: false,
      };
    }

    // Insufficient tokens: update bucket state with refilled balance and compute Retry-After
    this.buckets.set(key, {
      tokens: currentTokens,
      lastRefillAt: now,
      windowResetAt,
    });

    const deficit = cost - currentTokens;
    const msUntilAvailable = Math.ceil(deficit / refillRatePerMs);
    const retryAfterSeconds = Math.max(1, Math.ceil(msUntilAvailable / 1000));

    return {
      allowed: false,
      limit: safeCapacity,
      remaining: 0,
      resetAt: now + msUntilAvailable,
      retryAfterSeconds,
      degraded: false,
    };
  }
}

/**
 * Formats standard rate-limit HTTP headers from a token bucket decision.
 */
export function buildTokenBucketHeaders(decision: TokenBucketDecision): Record<string, string> {
  const headers: Record<string, string> = {
    "X-RateLimit-Limit": String(decision.limit),
    "X-RateLimit-Remaining": String(decision.remaining),
    "X-RateLimit-Reset": String(Math.ceil(decision.resetAt / 1000)),
  };
  if (!decision.allowed) {
    headers["Retry-After"] = String(decision.retryAfterSeconds);
  }
  return headers;
}
