import { describe, it, expect, beforeEach } from "vitest";
import {
  TokenBucketRateLimiter,
  buildTokenBucketHeaders,
  DEFAULT_MAX_BUCKET_KEYS,
} from "./token-bucket";
import { checkRateLimitDetailed, resetMemoryStore, getMemoryStoreSize } from "../redis";

describe("O(1) Token Bucket Rate Limiter & Bounded LRU Eviction (#2072)", () => {
  let limiter: TokenBucketRateLimiter;

  beforeEach(() => {
    limiter = new TokenBucketRateLimiter({ maxKeys: 100 });
    resetMemoryStore();
  });

  it("allows burst up to capacity and rejects excess with accurate Retry-After headers", () => {
    const t0 = 1_700_000_000_000;
    const capacity = 5;
    const windowSeconds = 10; // 0.5 tokens/sec -> 1 token every 2000ms

    for (let i = 0; i < capacity; i++) {
      const res = limiter.consume("client-1", capacity, windowSeconds, 1, t0);
      expect(res.allowed).toBe(true);
      expect(res.remaining).toBe(capacity - 1 - i);
      expect(res.limit).toBe(capacity);
    }

    const rejected = limiter.consume("client-1", capacity, windowSeconds, 1, t0);
    expect(rejected.allowed).toBe(false);
    expect(rejected.remaining).toBe(0);
    expect(rejected.retryAfterSeconds).toBe(2);

    const headers = buildTokenBucketHeaders(rejected);
    expect(headers["X-RateLimit-Limit"]).toBe("5");
    expect(headers["X-RateLimit-Remaining"]).toBe("0");
    expect(headers["X-RateLimit-Reset"]).toBeDefined();
    expect(headers["Retry-After"]).toBe("2");
  });

  it("continuously replenishes tokens over elapsed time without storing per-request logs", () => {
    const t0 = 1_700_000_000_000;
    const capacity = 10;
    const windowSeconds = 10; // 1 token per second

    // Drain all 10 tokens at t0
    for (let i = 0; i < 10; i++) {
      expect(limiter.consume("client-refill", capacity, windowSeconds, 1, t0).allowed).toBe(true);
    }
    expect(limiter.consume("client-refill", capacity, windowSeconds, 1, t0).allowed).toBe(false);

    // Advance 3.5 seconds -> 3.5 tokens replenished
    const t1 = t0 + 3500;
    expect(limiter.consume("client-refill", capacity, windowSeconds, 1, t1).allowed).toBe(true); // 2.5 left
    expect(limiter.consume("client-refill", capacity, windowSeconds, 1, t1).allowed).toBe(true); // 1.5 left
    expect(limiter.consume("client-refill", capacity, windowSeconds, 1, t1).allowed).toBe(true); // 0.5 left
    expect(limiter.consume("client-refill", capacity, windowSeconds, 1, t1).allowed).toBe(false);

    // Bucket stores strictly O(1) constant scalar fields (no per-request timestamp array)
    const entry = limiter.peek("client-refill");
    expect(entry).toBeDefined();
    expect(Object.keys(entry!)).toEqual(["tokens", "lastRefillAt", "windowResetAt"]);
  });

  it("caps replenishment at bucket capacity even after long idle periods", () => {
    const t0 = 1_700_000_000_000;
    limiter.consume("idle-client", 5, 10, 1, t0);

    // Advance 1 hour
    const res = limiter.consume("idle-client", 5, 10, 1, t0 + 3_600_000);
    expect(res.allowed).toBe(true);
    expect(res.remaining).toBe(4);
  });

  it("enforces bounded LRU eviction under high-cardinality traffic spikes", () => {
    const smallLimiter = new TokenBucketRateLimiter({ maxKeys: 3 });
    const t0 = 1_700_000_000_000;

    smallLimiter.consume("ip-1", 10, 60, 1, t0);
    smallLimiter.consume("ip-2", 10, 60, 1, t0);
    smallLimiter.consume("ip-3", 10, 60, 1, t0);
    expect(smallLimiter.size).toBe(3);

    // Touch ip-1 so ip-2 becomes Least-Recently-Used
    smallLimiter.consume("ip-1", 10, 60, 1, t0 + 100);

    // Adding ip-4 must evict ip-2 (LRU), keeping ip-1 and ip-3
    smallLimiter.consume("ip-4", 10, 60, 1, t0 + 200);
    expect(smallLimiter.size).toBe(3);
    expect(smallLimiter.peek("ip-2")).toBeUndefined();
    expect(smallLimiter.peek("ip-1")).toBeDefined();
    expect(smallLimiter.peek("ip-3")).toBeDefined();
    expect(smallLimiter.peek("ip-4")).toBeDefined();
  });

  it("bounds memory to DEFAULT_MAX_BUCKET_KEYS under 15,000 simulated unique attacker IPs", () => {
    const defaultLimiter = new TokenBucketRateLimiter();
    const t0 = 1_700_000_000_000;

    for (let i = 0; i < 15_000; i++) {
      defaultLimiter.consume(`attacker-ip-${i}`, 60, 60, 1, t0);
    }

    expect(defaultLimiter.size).toBe(DEFAULT_MAX_BUCKET_KEYS);
  });

  it("integrates with src/lib/redis.ts checkRateLimitDetailed in-memory fallback", async () => {
    const key = "rate-limit:test:token-bucket-integration";
    for (let i = 0; i < 4; i++) {
      const res = await checkRateLimitDetailed(key, 4, 60);
      expect(res.allowed).toBe(true);
    }
    const blocked = await checkRateLimitDetailed(key, 4, 60);
    expect(blocked.allowed).toBe(false);
    expect(blocked.remaining).toBe(0);
    expect(getMemoryStoreSize()).toBe(1);
  });
});
