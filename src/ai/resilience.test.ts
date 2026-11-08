import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const recordModelExecution = vi.fn().mockResolvedValue(undefined);

vi.mock("./telemetry", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./telemetry")>();
  return {
    ...actual,
    recordModelExecution: (...args: unknown[]) => recordModelExecution(...args),
    recordFailoverEvent: vi.fn().mockResolvedValue(undefined),
  };
});

import {
  computeBackoffDelay,
  isRateLimitError,
  isTimeoutError,
  executeWithFallbackAndRetry,
  getModelCircuitBreaker,
  resetModelCircuitBreakers,
  tripModelCircuitBreaker,
  CircuitState,
  CircuitBreakerError,
} from "./resilience";

const rateLimit = () => Object.assign(new Error("Too many requests"), { status: 429 });

describe("error classifiers", () => {
  it("detects rate limit errors by status and message", () => {
    expect(isRateLimitError({ status: 429 })).toBe(true);
    expect(isRateLimitError({ statusCode: 429 })).toBe(true);
    expect(isRateLimitError(new Error("Rate limit reached"))).toBe(true);
    expect(isRateLimitError(new Error("quota exceeded"))).toBe(true);
    expect(isRateLimitError(new Error("bad request"))).toBe(false);
    expect(isRateLimitError(null)).toBe(false);
  });

  it("does not flag messages that merely contain the digits 429", () => {
    expect(isRateLimitError(new Error("Processed 14290 findings"))).toBe(false);
    expect(isRateLimitError(new Error("Buffer size 4294967295 exceeded"))).toBe(false);
    expect(isRateLimitError(new Error("HTTP 429 Too Many Requests"))).toBe(true);
  });

  it("detects timeout / transient network errors", () => {
    expect(isTimeoutError({ status: 503 })).toBe(true);
    expect(isTimeoutError({ status: 504 })).toBe(true);
    expect(isTimeoutError(new Error("ECONNRESET"))).toBe(true);
    expect(isTimeoutError(new Error("request timed out"))).toBe(true);
    expect(isTimeoutError(new Error("deadline exceeded"))).toBe(true);
    expect(isTimeoutError(new Error("invalid api key"))).toBe(false);
    expect(isTimeoutError(undefined)).toBe(false);
  });
});

describe("computeBackoffDelay", () => {
  afterEach(() => vi.restoreAllMocks());

  it("grows exponentially without jitter", () => {
    expect(computeBackoffDelay(1, 100, 5000, 2, false)).toBe(100);
    expect(computeBackoffDelay(2, 100, 5000, 2, false)).toBe(200);
    expect(computeBackoffDelay(3, 100, 5000, 2, false)).toBe(400);
  });

  it("caps at maxDelayMs", () => {
    expect(computeBackoffDelay(10, 100, 1000, 2, false)).toBe(1000);
  });

  it("keeps jitter within +/-25% of the capped delay", () => {
    vi.spyOn(Math, "random").mockReturnValue(0);
    expect(computeBackoffDelay(1, 100, 5000, 2, true)).toBe(75);
    vi.spyOn(Math, "random").mockReturnValue(1);
    expect(computeBackoffDelay(1, 100, 5000, 2, true)).toBe(125);
    vi.spyOn(Math, "random").mockReturnValue(0.5);
    expect(computeBackoffDelay(1, 100, 5000, 2, true)).toBe(100);
  });
});

describe("executeWithFallbackAndRetry", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    resetModelCircuitBreakers();
    recordModelExecution.mockClear();
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  const baseRetry = { initialDelayMs: 100, maxDelayMs: 1000, jitter: false };

  it("returns immediately when the primary model succeeds", async () => {
    const op = vi.fn().mockResolvedValue("ok");
    const { result, stats } = await executeWithFallbackAndRetry(op, {
      primaryModel: "primary",
      fallbackModels: ["secondary"],
      retryConfig: baseRetry,
    });
    expect(result).toBe("ok");
    expect(op).toHaveBeenCalledTimes(1);
    expect(stats).toMatchObject({
      modelUsed: "primary",
      totalAttempts: 1,
      fallbackSwitches: 0,
      succeeded: true,
    });
  });

  it("retries a 429 with backoff and then succeeds on the same model", async () => {
    const op = vi
      .fn()
      .mockRejectedValueOnce(rateLimit())
      .mockRejectedValueOnce(rateLimit())
      .mockResolvedValueOnce("ok");

    const p = executeWithFallbackAndRetry(op, {
      primaryModel: "primary",
      fallbackModels: ["secondary"],
      retryConfig: baseRetry,
    });

    await vi.advanceTimersByTimeAsync(99);
    expect(op).toHaveBeenCalledTimes(1); // first backoff (100ms) not elapsed yet
    await vi.advanceTimersByTimeAsync(1);
    expect(op).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(200); // second backoff
    const { stats } = await p;

    expect(op).toHaveBeenCalledTimes(3);
    expect(stats.modelUsed).toBe("primary");
    expect(stats.totalAttempts).toBe(3);
    expect(stats.fallbackSwitches).toBe(0);
  });

  it("falls back to the next model after retries are exhausted", async () => {
    const onModelSwitch = vi.fn();
    const op = vi.fn(async (model: string) => {
      if (model === "primary") throw rateLimit();
      return "from-fallback";
    });

    const p = executeWithFallbackAndRetry(op, {
      primaryModel: "primary",
      fallbackModels: ["secondary"],
      retryConfig: { ...baseRetry, maxRetriesPerModel: 2 },
      onModelSwitch,
    });
    await vi.runAllTimersAsync();
    const { result, stats } = await p;

    expect(result).toBe("from-fallback");
    expect(stats).toMatchObject({
      modelUsed: "secondary",
      totalAttempts: 3, // 2 on primary + 1 on secondary
      fallbackSwitches: 1,
    });
    expect(onModelSwitch).toHaveBeenCalledWith("primary", "secondary", expect.anything(), 2);
  });

  it("does not retry a non-retryable error on the primary model", async () => {
    const op = vi.fn(async (model: string) => {
      if (model === "primary") throw new Error("invalid api key");
      return "ok";
    });
    const p = executeWithFallbackAndRetry(op, {
      primaryModel: "primary",
      fallbackModels: ["secondary"],
      retryConfig: baseRetry,
    });
    await vi.runAllTimersAsync();
    const { stats } = await p;

    expect(op.mock.calls.filter(([m]) => m === "primary")).toHaveLength(1);
    expect(stats.modelUsed).toBe("secondary");
  });

  it("honours custom retryableErrors predicates", async () => {
    const custom = new Error("flaky upstream");
    const op = vi.fn().mockRejectedValueOnce(custom).mockResolvedValueOnce("ok");
    const p = executeWithFallbackAndRetry(op, {
      primaryModel: "primary",
      fallbackModels: [],
      retryConfig: { ...baseRetry, retryableErrors: [(e) => String(e).includes("flaky")] },
    });
    await vi.runAllTimersAsync();
    await expect(p).resolves.toMatchObject({ result: "ok" });
    expect(op).toHaveBeenCalledTimes(2);
  });

  it("throws the last error when every model in the chain fails", async () => {
    const op = vi.fn().mockRejectedValue(rateLimit());
    const p = executeWithFallbackAndRetry(op, {
      primaryModel: "primary",
      fallbackModels: ["secondary"],
      retryConfig: { ...baseRetry, maxRetriesPerModel: 2 },
    });
    const assertion = expect(p).rejects.toThrow("Too many requests");
    await vi.runAllTimersAsync();
    await assertion;
    expect(op).toHaveBeenCalledTimes(4);
  });

  describe("timeout handling", () => {
    it("treats a stalled model as a TimeoutError and falls back", async () => {
      const op = vi.fn((model: string) =>
        model === "primary" ? new Promise<string>(() => {}) : Promise.resolve("ok"),
      );
      const p = executeWithFallbackAndRetry(op, {
        primaryModel: "primary",
        fallbackModels: ["secondary"],
        retryConfig: { ...baseRetry, maxRetriesPerModel: 1, timeoutMs: 1000 },
      });
      await vi.advanceTimersByTimeAsync(1000);
      const { stats } = await p;
      expect(stats.modelUsed).toBe("secondary");
      expect(stats.fallbackSwitches).toBe(1);
    });

    it("rejects with a TimeoutError when there is no fallback", async () => {
      const op = vi.fn(() => new Promise<string>(() => {}));
      const p = executeWithFallbackAndRetry(op, {
        primaryModel: "primary",
        fallbackModels: [],
        retryConfig: { ...baseRetry, maxRetriesPerModel: 1, timeoutMs: 500 },
      });
      const assertion = expect(p).rejects.toMatchObject({ name: "TimeoutError" });
      await vi.advanceTimersByTimeAsync(500);
      await assertion;
    });

    it("disables the timeout when timeoutMs is 0", async () => {
      const op = vi.fn(
        () => new Promise<string>((resolve) => setTimeout(() => resolve("slow-ok"), 60_000)),
      );
      const p = executeWithFallbackAndRetry(op, {
        primaryModel: "primary",
        fallbackModels: [],
        retryConfig: { ...baseRetry, timeoutMs: 0 },
      });
      await vi.advanceTimersByTimeAsync(60_000);
      await expect(p).resolves.toMatchObject({ result: "slow-ok" });
    });
  });

  describe("circuit breaker", () => {
    const cb = { failureThreshold: 1, resetTimeoutMs: 60_000 };

    it("opens after failures and fast-fails to the fallback on the next call", async () => {
      const op = vi.fn(async (model: string) => {
        if (model === "primary") throw rateLimit();
        return "ok";
      });
      const config = {
        primaryModel: "primary",
        fallbackModels: ["secondary"],
        retryConfig: baseRetry,
        circuitBreakerOptions: cb,
      };

      const first = executeWithFallbackAndRetry(op, config);
      await vi.runAllTimersAsync();
      await first;
      expect(getModelCircuitBreaker("primary").getState()).toBe(CircuitState.OPEN);

      op.mockClear();
      const onModelSwitch = vi.fn();
      const second = await executeWithFallbackAndRetry(op, { ...config, onModelSwitch });

      expect(op.mock.calls.some(([m]) => m === "primary")).toBe(false); // primary skipped
      expect(second.stats.modelUsed).toBe("secondary");
      expect(onModelSwitch).toHaveBeenCalledWith("primary", "secondary", expect.anything(), 0);
    });
  });

  describe("last-model OPEN breaker", () => {
    it("fails fast without spinning the retry loop or phantom telemetry", async () => {
      // Regression: with no fallback models, an OPEN breaker skipped the
      // fast-fail guard, breaker.execute() threw instantly, and the retry
      // loop spun maxRetriesPerModel times recording phantom failures.
      tripModelCircuitBreaker("primary");
      const op = vi.fn().mockResolvedValue("ok");

      await expect(
        executeWithFallbackAndRetry(op, {
          primaryModel: "primary",
          fallbackModels: [],
          retryConfig: { ...baseRetry, maxRetriesPerModel: 3 },
        }),
      ).rejects.toBeInstanceOf(CircuitBreakerError);

      expect(op).not.toHaveBeenCalled();
      // Exactly one recorded attempt — not one per retry spin.
      expect(recordModelExecution).toHaveBeenCalledTimes(1);
    });
  });
});
