/**
 * Adaptive Sliding-Window Rate Limiter (#2227)
 *
 * Uses weighted previous + current fixed-window counters to approximate a smooth
 * sliding window without storing per-request timestamps, bounds memory via
 * deterministic oldest-entry eviction, and emits standard X-RateLimit-* headers.
 */

export interface SlidingWindowConfig {
  /** Maximum requests allowed per window. */
  limit: number;
  /** Window duration in milliseconds (default: 60_000). */
  windowMs: number;
  /** Optional extra burst capacity above `limit` (default: 0). */
  burstAllowance?: number;
  /** Maximum tracked tenant/IP keys before evicting oldest (default: 10_000). */
  maxKeys?: number;
  /** Deterministic clock for testing (default: Date.now). */
  now?: () => number;
}

export interface SlidingWindowDecision {
  allowed: boolean;
  limit: number;
  remaining: number;
  estimatedCount: number;
  resetAtEpochSeconds: number;
  retryAfterSeconds: number;
  headers: Record<string, string>;
}

interface WindowBucketState {
  currentWindowStart: number;
  currentCount: number;
  previousCount: number;
  lastSeenMs: number;
}

export class SlidingWindowRateLimiter {
  private readonly limit: number;
  private readonly effectiveLimit: number;
  private readonly windowMs: number;
  private readonly maxKeys: number;
  private readonly now: () => number;
  private readonly store = new Map<string, WindowBucketState>();

  constructor(config: SlidingWindowConfig) {
    this.limit = Math.max(1, Math.floor(config.limit));
    this.effectiveLimit = this.limit + Math.max(0, Math.floor(config.burstAllowance ?? 0));
    this.windowMs = Math.max(100, Math.floor(config.windowMs));
    this.maxKeys = Math.max(1, Math.floor(config.maxKeys ?? 10_000));
    this.now = config.now ?? (() => Date.now());
  }

  private evictIfFull(incomingKey: string): void {
    if (this.store.has(incomingKey) || this.store.size < this.maxKeys) {
      return;
    }
    // Map preserves insertion order; delete oldest entry (first key)
    const oldestKey = this.store.keys().next().value;
    if (oldestKey !== undefined) {
      this.store.delete(oldestKey);
    }
  }

  public consume(key: string, cost = 1): SlidingWindowDecision {
    const nowMs = this.now();
    const currentWindowStart = Math.floor(nowMs / this.windowMs) * this.windowMs;
    const elapsedInWindow = nowMs - currentWindowStart;
    const prevWeight = Math.max(0, (this.windowMs - elapsedInWindow) / this.windowMs);

    this.evictIfFull(key);

    let state = this.store.get(key);
    if (!state) {
      state = {
        currentWindowStart,
        currentCount: 0,
        previousCount: 0,
        lastSeenMs: nowMs,
      };
    } else if (state.currentWindowStart !== currentWindowStart) {
      const windowsElapsed = Math.floor(
        (currentWindowStart - state.currentWindowStart) / this.windowMs,
      );
      state = {
        currentWindowStart,
        previousCount: windowsElapsed === 1 ? state.currentCount : 0,
        currentCount: 0,
        lastSeenMs: nowMs,
      };
    } else {
      state.lastSeenMs = nowMs;
    }

    // Refresh insertion order for LRU-like eviction
    this.store.delete(key);
    this.store.set(key, state);

    const weightedPrevious = state.previousCount * prevWeight;
    const estimatedBefore = weightedPrevious + state.currentCount;
    const projected = estimatedBefore + Math.max(1, cost);
    const allowed = projected <= this.effectiveLimit;

    if (allowed) {
      state.currentCount += Math.max(1, cost);
    }

    const estimatedCount = Math.ceil(allowed ? projected : estimatedBefore);
    const remaining = Math.max(0, this.effectiveLimit - estimatedCount);
    const windowEndMs = currentWindowStart + this.windowMs;
    const resetAtEpochSeconds = Math.ceil(windowEndMs / 1000);
    const retryAfterSeconds = allowed ? 0 : Math.max(1, Math.ceil((windowEndMs - nowMs) / 1000));

    const headers: Record<string, string> = {
      "X-RateLimit-Limit": String(this.effectiveLimit),
      "X-RateLimit-Remaining": String(remaining),
      "X-RateLimit-Reset": String(resetAtEpochSeconds),
      ...(allowed ? {} : { "Retry-After": String(retryAfterSeconds) }),
    };

    return {
      allowed,
      limit: this.effectiveLimit,
      remaining,
      estimatedCount,
      resetAtEpochSeconds,
      retryAfterSeconds,
      headers,
    };
  }

  public size(): number {
    return this.store.size;
  }

  public clear(): void {
    this.store.clear();
  }
}
