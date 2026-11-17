/**
 * AI Execution Resilience Engine (#729)
 *
 * Implements exponential backoff, jitter, rate-limit (429)/timeout recovery,
 * globally applied circuit-breaker state, and secondary/tertiary model fallback routing
 * for Genkit & Groq AI security workflows.
 */

import {
  CircuitBreaker,
  CircuitBreakerError,
  CircuitState,
  RedisCircuitBreakerStateStore,
  type CircuitBreakerOptions,
  type CircuitBreakerStateStore,
} from "@/lib/utils/circuit-breaker";
import { redis } from "@/lib/redis";
import { recordModelExecution, recordFailoverEvent } from "./telemetry";

export {
  CircuitBreaker,
  CircuitBreakerError,
  CircuitState,
  RedisCircuitBreakerStateStore,
  type CircuitBreakerOptions,
  type CircuitBreakerStateStore,
};

/**
 * Default per-attempt timeout. Long enough for a cloud completion, short
 * enough that a wedged local model does not pin a worker indefinitely.
 */
export const DEFAULT_ATTEMPT_TIMEOUT_MS = 15_000;

/**
 * Shared Redis circuit breaker state store across multi-replica pods (#1699).
 * If Redis is not configured (or during local mode), gracefully degrades to in-memory fallback.
 */
let sharedRedisBreakerStore: CircuitBreakerStateStore | null = null;

export function getSharedCircuitBreakerStore(): CircuitBreakerStateStore | null {
  if (!sharedRedisBreakerStore && redis) {
    sharedRedisBreakerStore = new RedisCircuitBreakerStateStore(redis, "circuit_breaker:ai:");
  }
  return sharedRedisBreakerStore;
}

export function setSharedCircuitBreakerStore(store: CircuitBreakerStateStore | null): void {
  sharedRedisBreakerStore = store;
}

/**
 * Global registry of circuit breakers per AI model.
 */
const modelCircuitBreakers = new Map<string, CircuitBreaker>();

export function getModelCircuitBreaker(
  modelName: string,
  options?: CircuitBreakerOptions,
): CircuitBreaker {
  const key = String(modelName).trim();
  let breaker = modelCircuitBreakers.get(key);
  if (!breaker) {
    const store =
      options?.store !== undefined ? options.store : (getSharedCircuitBreakerStore() ?? undefined);
    breaker = new CircuitBreaker({
      failureThreshold: options?.failureThreshold ?? 3,
      resetTimeoutMs: options?.resetTimeoutMs ?? 30_000,
      key: options?.key ?? `model:${key}`,
      store,
    });
    modelCircuitBreakers.set(key, breaker);
  }
  return breaker;
}

export function getAllModelCircuitBreakers(): Map<string, CircuitBreaker> {
  return new Map(modelCircuitBreakers);
}

export function tripModelCircuitBreaker(modelName: string, customTimeoutMs?: number): void {
  const breaker = getModelCircuitBreaker(modelName);
  breaker.trip(customTimeoutMs);
}

export function resetModelCircuitBreaker(modelName: string): void {
  const breaker = getModelCircuitBreaker(modelName);
  breaker.reset();
}

export function resetModelCircuitBreakers(): void {
  modelCircuitBreakers.clear();
}

/**
 * Wraps an async operation with a timeout to prevent hanging on stalled local models (#988).
 */
async function withTimeout<T>(fn: () => Promise<T>, timeoutMs: number): Promise<T> {
  if (!timeoutMs || timeoutMs <= 0) return fn();
  let timer: NodeJS.Timeout;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      const err = new Error(`Model inference timed out after ${timeoutMs}ms`);
      // `isTimeoutError` keys off both the name and the message, so this error
      // is retried and falls back like any transport-level timeout.
      err.name = "TimeoutError";
      reject(err);
    }, timeoutMs);
  });
  try {
    return await Promise.race([fn(), timeoutPromise]);
  } finally {
    clearTimeout(timer!);
  }
}

export interface RetryConfig {
  maxRetriesPerModel?: number;
  initialDelayMs?: number;
  maxDelayMs?: number;
  backoffFactor?: number;
  jitter?: boolean;
  retryableErrors?: Array<(error: unknown) => boolean>;
  /**
   * Per-attempt wall-clock budget in milliseconds (#988).
   *
   * Each individual call to `operation` is raced against this budget, so a
   * stalled local inference server surfaces a `TimeoutError` that the retry
   * and fallback logic can act on instead of hanging the caller forever.
   * Defaults to {@link DEFAULT_ATTEMPT_TIMEOUT_MS}; set it to `0` to disable
   * the timeout for a long-running operation such as a streamed generation.
   */
  timeoutMs?: number;
}

// ---------------------------------------------------------------------------
// Semaphore & VRAM Concurrency Control (#1753)
// ---------------------------------------------------------------------------

export interface SemaphoreAcquireOptions {
  timeoutMs?: number;
  signal?: AbortSignal;
}

/**
 * Concurrency semaphore with FIFO queueing, timeout bounds, and abort support (#1753).
 * Limits simultaneous active GPU/VRAM generations to prevent local inference crashes.
 */
export class Semaphore {
  private permits: number;
  private maxPermits: number;
  private queue: Array<{
    resolve: (release: () => void) => void;
    reject: (err: Error) => void;
    timer?: NodeJS.Timeout;
    signal?: AbortSignal;
    onAbort?: () => void;
  }> = [];

  constructor(permits = 1) {
    this.maxPermits = Math.max(1, permits);
    this.permits = this.maxPermits;
  }

  get availablePermits(): number {
    return this.permits;
  }

  get queueLength(): number {
    return this.queue.length;
  }

  get capacity(): number {
    return this.maxPermits;
  }

  setCapacity(newCapacity: number): void {
    const diff = newCapacity - this.maxPermits;
    this.maxPermits = Math.max(1, newCapacity);
    this.permits += diff;
    while (this.permits > 0 && this.queue.length > 0) {
      this.dispatchNext();
    }
  }

  async acquire(options?: SemaphoreAcquireOptions): Promise<() => void> {
    if (options?.signal?.aborted) {
      const err = new Error("Operation aborted while acquiring semaphore permit");
      err.name = "AbortError";
      throw err;
    }

    if (this.permits > 0) {
      this.permits--;
      let released = false;
      return () => {
        if (!released) {
          released = true;
          this.release();
        }
      };
    }

    return new Promise<() => void>((resolve, reject) => {
      let timer: NodeJS.Timeout | undefined;
      let onAbort: (() => void) | undefined;

      const entry = {
        resolve: (releaseFn: () => void) => {
          if (timer) clearTimeout(timer);
          if (options?.signal && onAbort) {
            options.signal.removeEventListener("abort", onAbort);
          }
          resolve(releaseFn);
        },
        reject: (err: Error) => {
          if (timer) clearTimeout(timer);
          if (options?.signal && onAbort) {
            options.signal.removeEventListener("abort", onAbort);
          }
          reject(err);
        },
      };

      if (options?.timeoutMs && options.timeoutMs > 0) {
        timer = setTimeout(() => {
          const idx = this.queue.indexOf(entry);
          if (idx !== -1) {
            this.queue.splice(idx, 1);
            entry.reject(
              new VRAMConcurrencyError(
                `Local model VRAM concurrency queue wait timed out after ${options.timeoutMs}ms`,
              ),
            );
          }
        }, options.timeoutMs);
      }

      if (options?.signal) {
        onAbort = () => {
          const idx = this.queue.indexOf(entry);
          if (idx !== -1) {
            this.queue.splice(idx, 1);
            const err = new Error("Operation aborted while waiting in semaphore queue");
            err.name = "AbortError";
            entry.reject(err);
          }
        };
        options.signal.addEventListener("abort", onAbort, { once: true });
      }

      this.queue.push(entry);
    });
  }

  private dispatchNext(): void {
    if (this.queue.length > 0 && this.permits > 0) {
      this.permits--;
      const next = this.queue.shift();
      if (next) {
        let released = false;
        next.resolve(() => {
          if (!released) {
            released = true;
            this.release();
          }
        });
      }
    }
  }

  private release(): void {
    this.permits++;
    this.dispatchNext();
  }

  reset(): void {
    while (this.queue.length > 0) {
      const item = this.queue.shift();
      const err = new Error("Semaphore reset");
      item?.reject(err);
    }
    this.permits = this.maxPermits;
  }
}

/**
 * Thrown when local inference requests exceed available GPU memory / concurrency limits (#1753).
 */
export class VRAMConcurrencyError extends Error {
  constructor(message = "Local model VRAM concurrency threshold exceeded") {
    super(message);
    this.name = "VRAMConcurrencyError";
  }
}

/**
 * Identifies errors caused by saturated local model VRAM or semaphore concurrency queue exhaustion.
 */
export function isVramConcurrencyError(err: unknown): boolean {
  if (!err) return false;
  if (err instanceof VRAMConcurrencyError) return true;
  const msg = err instanceof Error ? err.message : String(err);
  return (
    /vram (?:concurrency|threshold)/i.test(msg) ||
    /concurrency queue/i.test(msg) ||
    /exceeded vram/i.test(msg)
  );
}

/**
 * Checks whether a given model identifier represents a locally-hosted LLM (e.g. Ollama, vLLM).
 */
export function isLocalModel(modelName: string): boolean {
  if (!modelName) return false;
  const name = String(modelName).toLowerCase();
  return (
    name.startsWith("openai/") ||
    name.startsWith("local/") ||
    name.includes("localhost") ||
    name.includes("ollama") ||
    name.includes("vllm")
  );
}

export const DEFAULT_LOCAL_VRAM_CONCURRENCY = 1;

/**
 * Resolves maximum permitted concurrent local model executions from environment.
 */
export function getLocalModelVramThreshold(
  env: Readonly<Record<string, string | undefined>> = process.env,
): number {
  const raw =
    env.LOCAL_AI_MAX_CONCURRENCY ??
    env.LOCAL_AI_CONCURRENCY_LIMIT ??
    env.VRAM_CONCURRENCY_THRESHOLD;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_LOCAL_VRAM_CONCURRENCY;
}

let localModelSemaphore: Semaphore | null = null;

export function getLocalModelSemaphore(capacity?: number): Semaphore {
  if (!localModelSemaphore) {
    const limit = capacity ?? getLocalModelVramThreshold();
    localModelSemaphore = new Semaphore(limit);
  }
  return localModelSemaphore;
}

export function resetLocalModelSemaphore(): void {
  if (localModelSemaphore) {
    localModelSemaphore.reset();
  }
  localModelSemaphore = null;
}

/**
 * Executes an operation within a concurrency semaphore slot.
 */
export async function withModelConcurrency<T>(
  fn: () => Promise<T>,
  options?: { semaphore?: Semaphore; timeoutMs?: number; signal?: AbortSignal },
): Promise<T> {
  const sem = options?.semaphore ?? getLocalModelSemaphore();
  const release = await sem.acquire({
    timeoutMs: options?.timeoutMs,
    signal: options?.signal,
  });
  try {
    return await fn();
  } finally {
    release();
  }
}

export interface ModelFallbackConfig<TModel = string> {
  primaryModel: TModel;
  fallbackModels: TModel[];
  retryConfig?: RetryConfig;
  circuitBreakerOptions?: CircuitBreakerOptions;
  concurrencySemaphore?: Semaphore;
  semaphore?: Semaphore;
  queueTimeoutMs?: number;
  signal?: AbortSignal;
  onModelSwitch?: (
    fromModel: TModel,
    toModel: TModel,
    error: unknown,
    attempt: number,
    reasonCode?: string,
  ) => void;
}

export interface ResilienceExecutionStats {
  modelUsed: string;
  totalAttempts: number;
  fallbackSwitches: number;
  executionDurationMs: number;
  succeeded: boolean;
}

/**
 * Determines if an error is a rate limit (HTTP 429 / Rate limit reached).
 */
export function isRateLimitError(err: unknown): boolean {
  if (!err) return false;
  const msg = String(err).toLowerCase();
  const status =
    (err as { status?: number; statusCode?: number })?.status ||
    (err as { status?: number; statusCode?: number })?.statusCode;

  return (
    status === 429 ||
    // Word boundary: substring matching flagged any message containing the
    // digits "429" (byte counts like "4294967295", ids like "14290") as a
    // rate limit, triggering pointless backoff retries and failovers.
    /\b429\b/.test(msg) ||
    msg.includes("rate limit") ||
    msg.includes("ratelimit") ||
    msg.includes("quota exceeded")
  );
}

/**
 * Determines if an error is a timeout or temporary network fault (503/504/timeout).
 */
export function isTimeoutError(err: unknown): boolean {
  if (!err) return false;
  const msg = String(err).toLowerCase();
  const status =
    (err as { status?: number; statusCode?: number })?.status ||
    (err as { status?: number; statusCode?: number })?.statusCode;

  return (
    status === 503 ||
    status === 504 ||
    msg.includes("timeout") ||
    msg.includes("timed out") ||
    msg.includes("econnreset") ||
    msg.includes("etimedout") ||
    msg.includes("deadline exceeded")
  );
}

/**
 * Computes backoff delay with optional random jitter.
 */
export function computeBackoffDelay(
  attempt: number,
  initialDelayMs = 100,
  maxDelayMs = 5000,
  backoffFactor = 2,
  useJitter = true,
): number {
  const calculated = initialDelayMs * Math.pow(backoffFactor, Math.max(0, attempt - 1));
  const capped = Math.min(calculated, maxDelayMs);

  if (!useJitter) return capped;
  const jitterRange = capped * 0.25;
  const randomJitter = (Math.random() * 2 - 1) * jitterRange;
  return Math.max(0, Math.round(capped + randomJitter));
}

/**
 * Sleeps for specified milliseconds.
 */
export function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Executes an AI operation across a chain of fallback models with exponential backoff,
 * retries, and per-model circuit breaker shielding.
 */
export async function executeWithFallbackAndRetry<T, TModel extends string = string>(
  operation: (model: TModel, attempt: number) => Promise<T>,
  config: ModelFallbackConfig<TModel>,
): Promise<{ result: T; stats: ResilienceExecutionStats }> {
  const startTime = Date.now();
  const models = [config.primaryModel, ...config.fallbackModels];
  const maxRetries = config.retryConfig?.maxRetriesPerModel ?? 3;
  const initialDelay = config.retryConfig?.initialDelayMs ?? 100;
  const maxDelay = config.retryConfig?.maxDelayMs ?? 5000;
  const backoffFactor = config.retryConfig?.backoffFactor ?? 2;
  const useJitter = config.retryConfig?.jitter ?? true;

  if (config.signal?.aborted) {
    const err = new Error("Operation aborted");
    err.name = "AbortError";
    throw err;
  }

  let totalAttempts = 0;
  let fallbackSwitches = 0;
  let lastError: unknown = null;

  for (let mIdx = 0; mIdx < models.length; mIdx++) {
    const currentModel = models[mIdx];
    const breaker = getModelCircuitBreaker(String(currentModel), config.circuitBreakerOptions);

    // If the model's circuit breaker is currently OPEN and fallback models are available,
    // fast-fail immediately to the next model without burning time on doomed retries.
    if (breaker.getState() === CircuitState.OPEN && mIdx < models.length - 1) {
      fallbackSwitches++;
      const nextModel = models[mIdx + 1];
      const openError = new CircuitBreakerError(
        `Circuit breaker is OPEN for model ${String(currentModel)}`,
      );
      lastError = openError;
      console.warn(
        `[AI_RESILIENCE] Circuit breaker is OPEN for model ${String(currentModel)}. Fast-failing to fallback model: ${String(nextModel)}`,
      );
      recordFailoverEvent({
        fromModel: String(currentModel),
        toModel: String(nextModel),
        error: openError,
        attempt: 0,
        fastFail: true,
        reasonCode: "circuit_breaker_open",
      }).catch(() => {});
      if (config.onModelSwitch) {
        config.onModelSwitch(currentModel, nextModel, openError, 0);
      }
      continue;
    }

    const isLocal = isLocalModel(String(currentModel));
    const sem = isLocal
      ? (config.semaphore ?? config.concurrencySemaphore ?? getLocalModelSemaphore())
      : undefined;

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      totalAttempts++;
      const attemptStartTime = Date.now();

      let release: (() => void) | undefined;
      try {
        if (sem) {
          release = await sem.acquire({
            timeoutMs: config.queueTimeoutMs ?? 5000,
            signal: config.signal,
          });
        }

        const timeoutMs = config.retryConfig?.timeoutMs ?? DEFAULT_ATTEMPT_TIMEOUT_MS;
        const result = await breaker.execute(() =>
          withTimeout(() => operation(currentModel, attempt), timeoutMs),
        );

        recordModelExecution(
          String(currentModel),
          Date.now() - attemptStartTime,
          true,
          attempt,
        ).catch(() => {});

        return {
          result,
          stats: {
            modelUsed: String(currentModel),
            totalAttempts,
            fallbackSwitches,
            executionDurationMs: Date.now() - startTime,
            succeeded: true,
          },
        };
      } catch (err) {
        lastError = err;
        recordModelExecution(
          String(currentModel),
          Date.now() - attemptStartTime,
          false,
          attempt,
          err,
        ).catch(() => {});

        if (config.signal?.aborted || (err as any)?.name === "AbortError") {
          throw err;
        }

        const isVram = isVramConcurrencyError(err);
        const isBreakerOpen = err instanceof CircuitBreakerError;
        const isRetryable =
          !isVram &&
          !isBreakerOpen &&
          (isRateLimitError(err) ||
            isTimeoutError(err) ||
            Boolean(
              config.retryConfig?.retryableErrors &&
              config.retryConfig.retryableErrors.some((fn) => fn(err)),
            ));

        if (attempt < maxRetries && isRetryable && breaker.getState() !== CircuitState.OPEN) {
          const waitTime = computeBackoffDelay(
            attempt,
            initialDelay,
            maxDelay,
            backoffFactor,
            useJitter,
          );
          console.warn(
            `[AI_RESILIENCE] Model ${String(currentModel)} failed on attempt ${attempt}/${maxRetries} (${String(err)}). Retrying in ${waitTime}ms...`,
          );
          await delay(waitTime);
        } else {
          // Attempt limit reached for current model, circuit breaker tripped, or non-retryable error
          if (mIdx >= models.length - 1) {
            // Last model: stop spinning. Without this break, an OPEN breaker
            // (or a retryable failure that tripped it mid-loop) made
            // breaker.execute() throw instantly and the loop spun
            // maxRetries times, writing a phantom telemetry failure per spin.
            break;
          }
          {
            fallbackSwitches++;
            const nextModel = models[mIdx + 1];
            const reasonCode = isVram
              ? "vram_concurrency_exceeded"
              : isRateLimitError(err)
                ? "rate_limit"
                : isTimeoutError(err)
                  ? "timeout"
                  : isBreakerOpen
                    ? "circuit_breaker_open"
                    : "model_exhausted";

            console.warn(
              `[AI_RESILIENCE] Primary model ${String(currentModel)} failed (${reasonCode}). Switching to fallback model: ${String(nextModel)}`,
            );

            recordFailoverEvent({
              fromModel: String(currentModel),
              toModel: String(nextModel),
              error: err,
              attempt,
              fastFail: false,
              reasonCode,
            }).catch(() => {});

            if (config.onModelSwitch) {
              config.onModelSwitch(currentModel, nextModel, err, attempt);
            }
            break; // Break inner loop to try next model in outer loop
          }
        }
      } finally {
        release?.();
      }
    }
  }

  console.error(
    `[AI_RESILIENCE] All models in fallback chain failed after ${totalAttempts} total attempts.`,
    lastError,
  );
  throw lastError instanceof Error
    ? lastError
    : new Error(`AI operation failed across all fallback models: ${String(lastError)}`);
}
