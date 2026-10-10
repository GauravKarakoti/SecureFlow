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
  type CircuitBreakerOptions,
} from "@/lib/utils/circuit-breaker";
import { recordModelExecution, recordFailoverEvent } from "./telemetry";

export { CircuitBreaker, CircuitBreakerError, CircuitState, type CircuitBreakerOptions };

/**
 * Default per-attempt timeout. Long enough for a cloud completion, short
 * enough that a wedged local model does not pin a worker indefinitely.
 */
export const DEFAULT_ATTEMPT_TIMEOUT_MS = 15_000;

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
    breaker = new CircuitBreaker(
      options ?? {
        failureThreshold: 3,
        resetTimeoutMs: 30_000,
      },
    );
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

export interface ModelFallbackConfig<TModel = string> {
  primaryModel: TModel;
  fallbackModels: TModel[];
  retryConfig?: RetryConfig;
  circuitBreakerOptions?: CircuitBreakerOptions;
  onModelSwitch?: (fromModel: TModel, toModel: TModel, error: unknown, attempt: number) => void;
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
    msg.includes("429") ||
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
      }).catch(() => {});
      if (config.onModelSwitch) {
        config.onModelSwitch(currentModel, nextModel, openError, 0);
      }
      continue;
    }

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      totalAttempts++;
      const attemptStartTime = Date.now();

      try {
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

        const isBreakerOpen = err instanceof CircuitBreakerError;
        const isRetryable =
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
          if (mIdx < models.length - 1) {
            fallbackSwitches++;
            const nextModel = models[mIdx + 1];
            console.warn(
              `[AI_RESILIENCE] Primary model ${String(currentModel)} exhausted or unrecoverable. Switching to fallback model: ${String(nextModel)}`,
            );

            recordFailoverEvent({
              fromModel: String(currentModel),
              toModel: String(nextModel),
              error: err,
              attempt,
              fastFail: false,
            }).catch(() => {});

            if (config.onModelSwitch) {
              config.onModelSwitch(currentModel, nextModel, err, attempt);
            }
            break; // Break inner loop to try next model in outer loop
          }
        }
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
