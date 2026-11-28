import { describe, expect, it } from "vitest";
import { SlidingWindowRateLimiter } from "./sliding-window";
import { evaluateLocalSlidingWindow } from "@/lib/middleware/rate-limit";

describe("Adaptive Sliding-Window Rate Limiter (#2227)", () => {
  it("enforces limits with weighted previous-window smoothing across boundary transitions", () => {
    let clockMs = 60_000; // Start of window 1
    const limiter = new SlidingWindowRateLimiter({
      limit: 10,
      windowMs: 60_000,
      now: () => clockMs,
    });

    // Consume 8 in window 1
    for (let i = 0; i < 8; i++) {
      expect(limiter.consume("tenant-a").allowed).toBe(true);
    }

    // Move 50% into window 2 (150_000ms): previous weight = 0.5 -> weighted prev = 4
    clockMs = 150_000;
    for (let i = 0; i < 6; i++) {
      expect(limiter.consume("tenant-a").allowed).toBe(true);
    }

    // 7th request in window 2 pushes estimated count to 4 + 7 = 11 > 10 -> blocked
    const blocked = limiter.consume("tenant-a");
    expect(blocked.allowed).toBe(false);
    expect(blocked.remaining).toBe(0);
    expect(blocked.retryAfterSeconds).toBe(30);
    expect(blocked.headers["Retry-After"]).toBe("30");
    expect(blocked.headers["X-RateLimit-Limit"]).toBe("10");
  });

  it("evicts oldest keys when maxKeys capacity is reached", () => {
    const limiter = new SlidingWindowRateLimiter({
      limit: 5,
      windowMs: 10_000,
      maxKeys: 2,
    });

    limiter.consume("k1");
    limiter.consume("k2");
    expect(limiter.size()).toBe(2);

    // Accessing k1 refreshes it, so k2 becomes oldest and gets evicted when k3 arrives
    limiter.consume("k1");
    limiter.consume("k3");
    expect(limiter.size()).toBe(2);
  });

  it("integrates with middleware rate-limit helper", () => {
    const decision = evaluateLocalSlidingWindow("127.0.0.1", {
      keyPrefix: "test-sw",
      limit: 3,
      windowSeconds: 60,
    });
    expect(decision.allowed).toBe(true);
    expect(decision.limit).toBe(3);
    expect(decision.headers["X-RateLimit-Remaining"]).toBe("2");
  });
});
