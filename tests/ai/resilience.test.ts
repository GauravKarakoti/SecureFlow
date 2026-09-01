import { describe, it, expect, vi } from 'vitest';
import {
  executeWithFallbackAndRetry,
  isRateLimitError,
  isTimeoutError,
  computeBackoffDelay,
} from '../../src/ai/resilience';

describe('AI Model Resilience, Fallback & Retry Logic (#729)', () => {
  describe('Error Detection Helpers', () => {
    it('should detect rate limit errors by HTTP status 429', () => {
      expect(isRateLimitError({ status: 429 })).toBe(true);
      expect(isRateLimitError({ statusCode: 429 })).toBe(true);
      expect(isRateLimitError(new Error('Rate limit exceeded'))).toBe(true);
      expect(isRateLimitError(new Error('429 Too Many Requests'))).toBe(true);
      expect(isRateLimitError(new Error('Quota exceeded'))).toBe(true);
      expect(isRateLimitError({ status: 500 })).toBe(false);
    });

    it('should detect timeout errors by HTTP status 503/504 or message', () => {
      expect(isTimeoutError({ status: 503 })).toBe(true);
      expect(isTimeoutError({ status: 504 })).toBe(true);
      expect(isTimeoutError(new Error('Connection timed out'))).toBe(true);
      expect(isTimeoutError(new Error('ECONNRESET'))).toBe(true);
      expect(isTimeoutError({ status: 400 })).toBe(false);
    });
  });

  describe('Exponential Backoff & Jitter Computation', () => {
    it('should calculate exponential backoff without jitter deterministically', () => {
      expect(computeBackoffDelay(1, 100, 5000, 2, false)).toBe(100);
      expect(computeBackoffDelay(2, 100, 5000, 2, false)).toBe(200);
      expect(computeBackoffDelay(3, 100, 5000, 2, false)).toBe(400);
      expect(computeBackoffDelay(4, 100, 5000, 2, false)).toBe(800);
    });

    it('should respect maxDelayMs ceiling during exponential backoff', () => {
      expect(computeBackoffDelay(10, 100, 1000, 2, false)).toBe(1000);
    });

    it('should include random jitter within expected range when enabled', () => {
      const delayVal = computeBackoffDelay(2, 100, 5000, 2, true);
      expect(delayVal).toBeGreaterThanOrEqual(150);
      expect(delayVal).toBeLessThanOrEqual(250);
    });
  });

  describe('Model Chain Configuration & Fallbacks', () => {
    it('should iterate through primary and fallback model chain in order', async () => {
      const attemptedModels: string[] = [];
      const operation = vi.fn().mockImplementation((model: string) => {
        attemptedModels.push(model);
        if (model === 'primary-model') throw { status: 429 };
        if (model === 'fallback-1') throw { status: 503 };
        return Promise.resolve('SUCCESS_ON_FALLBACK_2');
      });

      const { result, stats } = await executeWithFallbackAndRetry(operation, {
        primaryModel: 'primary-model',
        fallbackModels: ['fallback-1', 'fallback-2', 'fallback-3'],
        retryConfig: { maxRetriesPerModel: 1, initialDelayMs: 1, jitter: false },
      });

      expect(result).toBe('SUCCESS_ON_FALLBACK_2');
      expect(attemptedModels).toEqual(['primary-model', 'fallback-1', 'fallback-2']);
      expect(stats.fallbackSwitches).toBe(2);
    });
  });

  describe('executeWithFallbackAndRetry', () => {
    it('should return result immediately if primary model succeeds on first attempt', async () => {
      const operation = vi.fn().mockResolvedValue('OK_RESPONSE');

      const { result, stats } = await executeWithFallbackAndRetry(operation, {
        primaryModel: 'groq/primary-model',
        fallbackModels: ['groq/fallback-1', 'groq/fallback-2'],
        retryConfig: { maxRetriesPerModel: 2, initialDelayMs: 10, jitter: false },
      });

      expect(result).toBe('OK_RESPONSE');
      expect(stats.modelUsed).toBe('groq/primary-model');
      expect(stats.totalAttempts).toBe(1);
      expect(stats.fallbackSwitches).toBe(0);
      expect(stats.succeeded).toBe(true);
      expect(operation).toHaveBeenCalledTimes(1);
    });

    it('should retry primary model on transient 429 rate limit error before succeeding', async () => {
      const operation = vi
        .fn()
        .mockRejectedValueOnce({ status: 429, message: 'Rate limit' })
        .mockResolvedValueOnce('RECOVERED_RESPONSE');

      const { result, stats } = await executeWithFallbackAndRetry(operation, {
        primaryModel: 'groq/primary-model',
        fallbackModels: ['groq/fallback-1'],
        retryConfig: { maxRetriesPerModel: 3, initialDelayMs: 5, jitter: false },
      });

      expect(result).toBe('RECOVERED_RESPONSE');
      expect(stats.modelUsed).toBe('groq/primary-model');
      expect(stats.totalAttempts).toBe(2);
      expect(stats.fallbackSwitches).toBe(0);
    });

    it('should failover to secondary model if primary model exhausts retries', async () => {
      const operation = vi.fn().mockImplementation((model: string) => {
        if (model === 'groq/primary-model') {
          return Promise.reject({ status: 429, message: 'Rate limit persistent' });
        }
        return Promise.resolve('FALLBACK_SUCCESS');
      });

      const onSwitch = vi.fn();

      const { result, stats } = await executeWithFallbackAndRetry(operation, {
        primaryModel: 'groq/primary-model',
        fallbackModels: ['groq/fallback-1', 'groq/fallback-2'],
        retryConfig: { maxRetriesPerModel: 2, initialDelayMs: 5, jitter: false },
        onModelSwitch: onSwitch,
      });

      expect(result).toBe('FALLBACK_SUCCESS');
      expect(stats.modelUsed).toBe('groq/fallback-1');
      expect(stats.fallbackSwitches).toBe(1);
      expect(onSwitch).toHaveBeenCalledWith(
        'groq/primary-model',
        'groq/fallback-1',
        expect.anything(),
        2
      );
    });

    it('should throw final error if all models in fallback chain fail', async () => {
      const operation = vi.fn().mockRejectedValue({ status: 503, message: 'Service Unavailable' });

      await expect(
        executeWithFallbackAndRetry(operation, {
          primaryModel: 'groq/primary-model',
          fallbackModels: ['groq/fallback-1'],
          retryConfig: { maxRetriesPerModel: 2, initialDelayMs: 5, jitter: false },
        })
      ).rejects.toThrow();
    });
  });
});
