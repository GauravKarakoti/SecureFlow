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
});
