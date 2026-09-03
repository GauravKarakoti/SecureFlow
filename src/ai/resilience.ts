/**
 * AI Execution Resilience Engine (#729)
 *
 * Implements exponential backoff, jitter, rate-limit (429)/timeout recovery,
 * and secondary/tertiary model fallback routing for Genkit & Groq AI security workflows.
 */

export interface RetryConfig {
  maxRetriesPerModel?: number;
  initialDelayMs?: number;
  maxDelayMs?: number;
  backoffFactor?: number;
  jitter?: boolean;
  retryableErrors?: Array<(error: unknown) => boolean>;
}

export interface ModelFallbackConfig<TModel = string> {
  primaryModel: TModel;
  fallbackModels: TModel[];
  retryConfig?: RetryConfig;
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
  const status = (err as { status?: number; statusCode?: number })?.status ||
                 (err as { status?: number; statusCode?: number })?.statusCode;

  return status === 429 || msg.includes('429') || msg.includes('rate limit') || msg.includes('ratelimit') || msg.includes('quota exceeded');
}

/**
 * Determines if an error is a timeout or temporary network fault (503/504/timeout).
 */
export function isTimeoutError(err: unknown): boolean {
  if (!err) return false;
  const msg = String(err).toLowerCase();
  const status = (err as { status?: number; statusCode?: number })?.status ||
                 (err as { status?: number; statusCode?: number })?.statusCode;

  return (
    status === 503 ||
    status === 504 ||
    msg.includes('timeout') ||
    msg.includes('timed out') ||
    msg.includes('econnreset') ||
    msg.includes('etimedout') ||
    msg.includes('deadline exceeded')
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
  useJitter = true
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
 * Executes an AI operation across a chain of fallback models with exponential backoff and retries.
 */
export async function executeWithFallbackAndRetry<T, TModel extends string = string>(
  operation: (model: TModel, attempt: number) => Promise<T>,
  config: ModelFallbackConfig<TModel>
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

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      totalAttempts++;

      try {
        const result = await operation(currentModel, attempt);
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
        const isRetryable =
          isRateLimitError(err) ||
          isTimeoutError(err) ||
          (config.retryConfig?.retryableErrors &&
            config.retryConfig.retryableErrors.some((fn) => fn(err)));

        if (attempt < maxRetries && isRetryable) {
          const waitTime = computeBackoffDelay(attempt, initialDelay, maxDelay, backoffFactor, useJitter);
          console.warn(
            `[AI_RESILIENCE] Model ${String(currentModel)} failed on attempt ${attempt}/${maxRetries} (${String(err)}). Retrying in ${waitTime}ms...`
          );
          await delay(waitTime);
        } else {
          // Attempt limit reached for current model or non-retryable error
          if (mIdx < models.length - 1) {
            fallbackSwitches++;
            const nextModel = models[mIdx + 1];
            console.warn(
              `[AI_RESILIENCE] Primary model ${String(currentModel)} exhausted or unrecoverable. Switching to fallback model: ${String(nextModel)}`
            );

            if (config.onModelSwitch) {
              config.onModelSwitch(currentModel, nextModel, err, attempt);
            }
            break; // Break inner loop to try next model in outer loop
          }
        }
      }
    }
  }

  console.error(`[AI_RESILIENCE] All models in fallback chain failed after ${totalAttempts} total attempts.`, lastError);
  throw lastError instanceof Error ? lastError : new Error(`AI operation failed across all fallback models: ${String(lastError)}`);
}
