import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import { CircuitBreaker, CircuitState, CircuitBreakerError } from "./circuit-breaker";

describe("CircuitBreaker", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("should start in CLOSED state", () => {
    const breaker = new CircuitBreaker();
    expect(breaker.getState()).toBe(CircuitState.CLOSED);
  });

  it("should execute action successfully in CLOSED state", async () => {
    const breaker = new CircuitBreaker();
    const result = await breaker.execute(async () => "success");
    expect(result).toBe("success");
    expect(breaker.getState()).toBe(CircuitState.CLOSED);
  });

  it("should transition to OPEN after failureThreshold is reached", async () => {
    const breaker = new CircuitBreaker({ failureThreshold: 3, resetTimeoutMs: 10000 });

    const failAction = async () => {
      throw new Error("Action failed");
    };

    // First failure
    await expect(breaker.execute(failAction)).rejects.toThrow("Action failed");
    expect(breaker.getState()).toBe(CircuitState.CLOSED);

    // Second failure
    await expect(breaker.execute(failAction)).rejects.toThrow("Action failed");
    expect(breaker.getState()).toBe(CircuitState.CLOSED);

    // Third failure (Threshold reached)
    await expect(breaker.execute(failAction)).rejects.toThrow("Action failed");
    expect(breaker.getState()).toBe(CircuitState.OPEN);
  });

  it("should throw CircuitBreakerError immediately when OPEN", async () => {
    const breaker = new CircuitBreaker({ failureThreshold: 1, resetTimeoutMs: 10000 });

    await expect(
      breaker.execute(async () => {
        throw new Error("Action failed");
      }),
    ).rejects.toThrow("Action failed");

    expect(breaker.getState()).toBe(CircuitState.OPEN);

    // Now it should fast-fail
    await expect(breaker.execute(async () => "will not execute")).rejects.toThrow(
      CircuitBreakerError,
    );
    await expect(breaker.execute(async () => "will not execute")).rejects.toThrow(
      "Circuit breaker is OPEN",
    );
  });

  it("should transition to HALF_OPEN after resetTimeoutMs", async () => {
    const breaker = new CircuitBreaker({ failureThreshold: 1, resetTimeoutMs: 10000 });

    await expect(
      breaker.execute(async () => {
        throw new Error("Action failed");
      }),
    ).rejects.toThrow("Action failed");

    expect(breaker.getState()).toBe(CircuitState.OPEN);

    // Advance time by 5 seconds
    vi.advanceTimersByTime(5000);
    expect(breaker.getState()).toBe(CircuitState.OPEN);

    // Advance time by another 5 seconds (total 10s)
    vi.advanceTimersByTime(5000);
    expect(breaker.getState()).toBe(CircuitState.HALF_OPEN);
  });

  it("should transition back to CLOSED if action succeeds in HALF_OPEN state", async () => {
    const breaker = new CircuitBreaker({ failureThreshold: 1, resetTimeoutMs: 10000 });

    await expect(
      breaker.execute(async () => {
        throw new Error("Action failed");
      }),
    ).rejects.toThrow("Action failed");

    // Advance time to HALF_OPEN
    vi.advanceTimersByTime(10000);
    expect(breaker.getState()).toBe(CircuitState.HALF_OPEN);

    // Execute successful action
    const result = await breaker.execute(async () => "recovered");
    expect(result).toBe("recovered");

    // Should be CLOSED now
    expect(breaker.getState()).toBe(CircuitState.CLOSED);
  });

  it("should transition back to OPEN if action fails in HALF_OPEN state", async () => {
    const breaker = new CircuitBreaker({ failureThreshold: 1, resetTimeoutMs: 10000 });

    await expect(
      breaker.execute(async () => {
        throw new Error("Action failed");
      }),
    ).rejects.toThrow("Action failed");

    // Advance time to HALF_OPEN
    vi.advanceTimersByTime(10000);
    expect(breaker.getState()).toBe(CircuitState.HALF_OPEN);

    // Execute failing action
    await expect(
      breaker.execute(async () => {
        throw new Error("Another failure");
      }),
    ).rejects.toThrow("Another failure");

    // Should be OPEN again
    expect(breaker.getState()).toBe(CircuitState.OPEN);

    // And timer should be reset
    vi.advanceTimersByTime(5000);
    expect(breaker.getState()).toBe(CircuitState.OPEN); // Still OPEN
  });

  it("should reset failure count on success", async () => {
    const breaker = new CircuitBreaker({ failureThreshold: 2, resetTimeoutMs: 10000 });

    // One failure
    await expect(
      breaker.execute(async () => {
        throw new Error("Action failed");
      }),
    ).rejects.toThrow("Action failed");
    expect(breaker.getState()).toBe(CircuitState.CLOSED);

    // One success
    await breaker.execute(async () => "success");
    expect(breaker.getState()).toBe(CircuitState.CLOSED);

    // One failure (should not trip because count was reset)
    await expect(
      breaker.execute(async () => {
        throw new Error("Action failed");
      }),
    ).rejects.toThrow("Action failed");
    expect(breaker.getState()).toBe(CircuitState.CLOSED);
  });
  it("admits only one probe while HALF_OPEN", async () => {
    const breaker = new CircuitBreaker({ failureThreshold: 2, resetTimeoutMs: 1000 });

    for (let i = 0; i < 2; i++) {
      await expect(
        breaker.execute(async () => {
          throw new Error("down");
        }),
      ).rejects.toThrow("down");
    }
    expect(breaker.getState()).toBe(CircuitState.OPEN);

    vi.advanceTimersByTime(1000);
    expect(breaker.getState()).toBe(CircuitState.HALF_OPEN);

    // The dependency is still down, so the probe hangs for its own timeout.
    // Everything that arrives meanwhile must be rejected by the breaker rather
    // than piling onto it.
    let releaseProbe: () => void = () => {};
    const attempts = vi.fn(
      () =>
        new Promise<string>((_, reject) => {
          releaseProbe = () => reject(new Error("down"));
        }),
    );

    const probe = breaker.execute(attempts);
    probe.catch(() => {});

    await expect(breaker.execute(attempts)).rejects.toBeInstanceOf(CircuitBreakerError);
    await expect(breaker.execute(attempts)).rejects.toBeInstanceOf(CircuitBreakerError);

    // Only the probe ever reached the dependency.
    expect(attempts).toHaveBeenCalledTimes(1);

    releaseProbe();
    await expect(probe).rejects.toThrow("down");
  });

  it("frees the probe slot when the probe fails, and re-arms the reset window", async () => {
    const breaker = new CircuitBreaker({ failureThreshold: 1, resetTimeoutMs: 1000 });

    await expect(
      breaker.execute(async () => {
        throw new Error("down");
      }),
    ).rejects.toThrow("down");

    vi.advanceTimersByTime(1000);
    await expect(
      breaker.execute(async () => {
        throw new Error("still down");
      }),
    ).rejects.toThrow("still down");

    // Back to OPEN with a fresh deadline, not stuck holding the probe slot.
    expect(breaker.getState()).toBe(CircuitState.OPEN);

    vi.advanceTimersByTime(1000);
    expect(breaker.getState()).toBe(CircuitState.HALF_OPEN);
    await expect(breaker.execute(async () => "recovered")).resolves.toBe("recovered");
    expect(breaker.getState()).toBe(CircuitState.CLOSED);
  });

  it("frees the probe slot when the probe succeeds", async () => {
    const breaker = new CircuitBreaker({ failureThreshold: 1, resetTimeoutMs: 1000 });

    await expect(
      breaker.execute(async () => {
        throw new Error("down");
      }),
    ).rejects.toThrow("down");

    vi.advanceTimersByTime(1000);
    await expect(breaker.execute(async () => "recovered")).resolves.toBe("recovered");

    // Closed again, so the next caller goes straight through.
    expect(breaker.getState()).toBe(CircuitState.CLOSED);
    await expect(breaker.execute(async () => "second")).resolves.toBe("second");
  });

  it("rejects a blocked caller with CircuitBreakerError, which callers treat as degraded", async () => {
    const breaker = new CircuitBreaker({ failureThreshold: 1, resetTimeoutMs: 1000 });

    await expect(
      breaker.execute(async () => {
        throw new Error("down");
      }),
    ).rejects.toThrow("down");
    vi.advanceTimersByTime(1000);

    let release: () => void = () => {};
    const probe = breaker.execute(
      () => new Promise<string>((resolve) => (release = () => resolve("ok"))),
    );

    // src/lib/redis.ts keys off error.name to stay quiet on an expected trip.
    await breaker
      .execute(async () => "blocked")
      .catch((err) => {
        expect(err).toBeInstanceOf(CircuitBreakerError);
        expect(err.name).toBe("CircuitBreakerError");
      });

    release();
    await expect(probe).resolves.toBe("ok");
  });

  describe("manual trip, reset, and getStats", () => {
    it("should allow manually tripping the circuit breaker", async () => {
      const breaker = new CircuitBreaker({ failureThreshold: 5, resetTimeoutMs: 15000 });
      expect(breaker.getState()).toBe(CircuitState.CLOSED);

      breaker.trip();
      expect(breaker.getState()).toBe(CircuitState.OPEN);

      const stats = breaker.getStats();
      expect(stats.state).toBe(CircuitState.OPEN);
      expect(stats.stateName).toBe("OPEN");
      expect(stats.isHealthy).toBe(false);

      await expect(breaker.execute(async () => "ok")).rejects.toThrow(CircuitBreakerError);
    });

    it("should allow manually resetting an OPEN circuit breaker", async () => {
      const breaker = new CircuitBreaker({ failureThreshold: 1, resetTimeoutMs: 15000 });
      breaker.trip();
      expect(breaker.getState()).toBe(CircuitState.OPEN);

      breaker.reset();
      expect(breaker.getState()).toBe(CircuitState.CLOSED);

      const stats = breaker.getStats();
      expect(stats.state).toBe(CircuitState.CLOSED);
      expect(stats.stateName).toBe("CLOSED");
      expect(stats.isHealthy).toBe(true);
      expect(stats.failureCount).toBe(0);

      const result = await breaker.execute(async () => "recovered");
      expect(result).toBe("recovered");
    });

    it("should accurately report HALF_OPEN in getStats", async () => {
      const breaker = new CircuitBreaker({ failureThreshold: 1, resetTimeoutMs: 5000 });
      breaker.trip();
      expect(breaker.getStats().stateName).toBe("OPEN");

      vi.advanceTimersByTime(5001);
      expect(breaker.getStats().stateName).toBe("HALF_OPEN");
      expect(breaker.getStats().state).toBe(CircuitState.HALF_OPEN);
      expect(breaker.getStats().isHealthy).toBe(false);
    });
  });

  describe("RedisCircuitBreakerStateStore & Multi-Replica State Sharing (#1699)", () => {
    let mockStorage: Map<string, string>;
    let mockRedisClient: any;

    beforeEach(() => {
      mockStorage = new Map();
      mockRedisClient = {
        get: vi.fn(async (key: string) => mockStorage.get(key) ?? null),
        set: vi.fn(async (key: string, value: string) => {
          mockStorage.set(key, value);
          return "OK";
        }),
        del: vi.fn(async (key: string) => {
          mockStorage.delete(key);
          return 1;
        }),
      };
    });

    it("persists trip and failure state to Redis store", async () => {
      const { RedisCircuitBreakerStateStore } = await import("./circuit-breaker");
      const store = new RedisCircuitBreakerStateStore(mockRedisClient, "test:cb:");
      const breaker = new CircuitBreaker({
        failureThreshold: 2,
        resetTimeoutMs: 20000,
        key: "ai:primary",
        store,
      });

      // Cause failures
      const failAction = async () => {
        throw new Error("fail");
      };
      await expect(breaker.execute(failAction)).rejects.toThrow("fail");
      expect(mockRedisClient.set).toHaveBeenCalled();

      // Second failure trips the breaker
      await expect(breaker.execute(failAction)).rejects.toThrow("fail");
      expect(breaker.getState()).toBe(CircuitState.OPEN);

      const storedRaw = mockStorage.get("test:cb:ai:primary");
      expect(storedRaw).toBeDefined();
      const parsed = JSON.parse(storedRaw!);
      expect(parsed.state).toBe(CircuitState.OPEN);
      expect(parsed.failureCount).toBe(2);
      expect(parsed.nextAttemptTimestamp).toBeGreaterThan(0);
    });

    it("shares tripped state across independent breaker instances (pod replicas)", async () => {
      const { RedisCircuitBreakerStateStore } = await import("./circuit-breaker");
      const store = new RedisCircuitBreakerStateStore(mockRedisClient, "test:cb:");

      // Pod A
      const podA = new CircuitBreaker({
        failureThreshold: 1,
        resetTimeoutMs: 15000,
        key: "shared:groq",
        store,
      });

      // Pod B
      const podB = new CircuitBreaker({
        failureThreshold: 1,
        resetTimeoutMs: 15000,
        key: "shared:groq",
        store,
      });

      // Pod A trips the breaker
      podA.trip();
      expect(podA.getState()).toBe(CircuitState.OPEN);

      // Pod B starts in CLOSED locally until syncFromStore or execute
      expect(podB.getState()).toBe(CircuitState.CLOSED);

      // Pod B executes action -> syncs state from Redis -> detects OPEN and fast-fails
      await expect(podB.execute(async () => "result")).rejects.toThrow(CircuitBreakerError);
      expect(podB.getState()).toBe(CircuitState.OPEN);
    });

    it("clears remote Redis state when reset is called", async () => {
      const { RedisCircuitBreakerStateStore } = await import("./circuit-breaker");
      const store = new RedisCircuitBreakerStateStore(mockRedisClient, "test:cb:");

      const podA = new CircuitBreaker({
        failureThreshold: 1,
        resetTimeoutMs: 15000,
        key: "shared:armoriq",
        store,
      });

      const podB = new CircuitBreaker({
        failureThreshold: 1,
        resetTimeoutMs: 15000,
        key: "shared:armoriq",
        store,
      });

      podA.trip();
      expect(mockStorage.has("test:cb:shared:armoriq")).toBe(true);

      // Reset from Pod B
      podB.reset();
      expect(mockRedisClient.del).toHaveBeenCalledWith("test:cb:shared:armoriq");
      expect(mockStorage.has("test:cb:shared:armoriq")).toBe(false);

      // Pod A syncs and is now CLOSED
      await podA.syncFromStore();
      // Since it was deleted, it retains last known or resets
      podA.reset();
      expect(podA.getState()).toBe(CircuitState.CLOSED);
    });

    it("handles Redis outage gracefully with in-memory fallback without throwing", async () => {
      const brokenRedisClient = {
        get: vi.fn().mockRejectedValue(new Error("Redis cluster down")),
        set: vi.fn().mockRejectedValue(new Error("Redis cluster down")),
        del: vi.fn().mockRejectedValue(new Error("Redis cluster down")),
      };

      const { RedisCircuitBreakerStateStore } = await import("./circuit-breaker");
      const store = new RedisCircuitBreakerStateStore(brokenRedisClient, "test:cb:");
      const breaker = new CircuitBreaker({
        failureThreshold: 1,
        resetTimeoutMs: 10000,
        key: "resilient:key",
        store,
      });

      // Normal execution should still work despite Redis error
      const res = await breaker.execute(async () => "healthy");
      expect(res).toBe("healthy");
      expect(breaker.getState()).toBe(CircuitState.CLOSED);

      // Failure tripping works locally
      await expect(
        breaker.execute(async () => {
          throw new Error("action error");
        }),
      ).rejects.toThrow("action error");

      expect(breaker.getState()).toBe(CircuitState.OPEN);
    });
  });
});
