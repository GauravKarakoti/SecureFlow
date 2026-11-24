/**
 * GitHub API Throttling & Rate Limit Resilience (#2014)
 *
 * Implements primary and secondary rate limit handling for GitHub API requests:
 * - Uses @octokit/plugin-throttling to handle primary and secondary rate limits.
 * - Retries rate-limited calls after the required delay (retry-after or reset time), bounded to MAX_RETRY_AFTER_SECONDS.
 * - Integrates with BullMQ / queue so rate-limited jobs are delayed rather than failed or moved to DLQ.
 * - Exposes throttle event metrics (total primary & secondary rate-limit events).
 * - Logs limit events sanitizing out any tokens or sensitive request payloads.
 */

import { throttling } from "@octokit/plugin-throttling";
import { Octokit } from "octokit";
import { createLogger } from "@/lib/logger";

const log = createLogger({ context: { component: "github-throttling" } });

/** Maximum delay (in seconds) we will wait inside the Octokit request before giving up and throwing */
export const MAX_RETRY_AFTER_SECONDS = 60;
/** Maximum automatic retries per request inside Octokit throttling plugin */
export const MAX_OCTOKIT_RETRIES = 3;

/** In-memory throttle metrics */
export interface GitHubThrottleMetrics {
  primaryRateLimitsTotal: number;
  secondaryRateLimitsTotal: number;
  totalThrottledRequests: number;
  lastThrottledAt?: string;
  lastRetryAfterSeconds?: number;
}

export const gitHubThrottleMetrics: GitHubThrottleMetrics = {
  primaryRateLimitsTotal: 0,
  secondaryRateLimitsTotal: 0,
  totalThrottledRequests: 0,
};

/** Reset metrics (useful for testing) */
export function resetGitHubThrottleMetrics(): void {
  gitHubThrottleMetrics.primaryRateLimitsTotal = 0;
  gitHubThrottleMetrics.secondaryRateLimitsTotal = 0;
  gitHubThrottleMetrics.totalThrottledRequests = 0;
  delete gitHubThrottleMetrics.lastThrottledAt;
  delete gitHubThrottleMetrics.lastRetryAfterSeconds;
}

/**
 * Returns current snapshot of GitHub throttle metrics.
 */
export function getGitHubThrottleMetrics(): GitHubThrottleMetrics {
  return { ...gitHubThrottleMetrics };
}

/**
 * Sanitizes request options to ensure tokens, authorization headers, or sensitive payloads
 * are never included in log entries.
 */
export function sanitizeRequestOptionsForLogging(
  options: Record<string, unknown>,
): Record<string, unknown> {
  const { method, url, request, headers, ...rest } = options;

  // Mask or omit Authorization header
  const sanitizedHeaders: Record<string, unknown> = {};
  if (headers && typeof headers === "object") {
    for (const [key, value] of Object.entries(headers as Record<string, unknown>)) {
      if (/authorization|token|key|secret/i.test(key)) {
        sanitizedHeaders[key] = "[REDACTED]";
      } else {
        sanitizedHeaders[key] = value;
      }
    }
  }

  return {
    method: method || "GET",
    url:
      typeof url === "string"
        ? url.replace(/([?&](?:access_token|client_secret|token)=)[^&]+/gi, "$1[REDACTED]")
        : url,
    // Do not log request body / payload
    hasPayload: Boolean((options as any).body || (options as any).data),
  };
}

export interface ThrottlePluginConfigOptions {
  maxRetries?: number;
  maxRetryAfterSeconds?: number;
  onRateLimitCallback?: (retryAfter: number, options: any) => void;
  onSecondaryRateLimitCallback?: (retryAfter: number, options: any) => void;
}

/**
 * Builds the throttle configuration object for `@octokit/plugin-throttling`.
 */
export function createThrottleConfig(configOptions: ThrottlePluginConfigOptions = {}) {
  const maxRetries = configOptions.maxRetries ?? MAX_OCTOKIT_RETRIES;
  const maxRetryAfter = configOptions.maxRetryAfterSeconds ?? MAX_RETRY_AFTER_SECONDS;

  return {
    enabled: true,
    onRateLimit: (
      retryAfter: number,
      options: Record<string, unknown>,
      _octokit: any,
      retryCount: number,
    ): boolean => {
      gitHubThrottleMetrics.primaryRateLimitsTotal++;
      gitHubThrottleMetrics.totalThrottledRequests++;
      gitHubThrottleMetrics.lastThrottledAt = new Date().toISOString();
      gitHubThrottleMetrics.lastRetryAfterSeconds = retryAfter;

      const safeOpts = sanitizeRequestOptionsForLogging(options);
      log.warn(
        `[GitHub Rate Limit] Primary limit hit for ${safeOpts.method} ${safeOpts.url}. Retry ${retryCount}/${maxRetries} after ${retryAfter}s.`,
        safeOpts,
      );

      configOptions.onRateLimitCallback?.(retryAfter, options);

      if (retryCount < maxRetries && retryAfter <= maxRetryAfter) {
        return true;
      }
      return false;
    },
    onSecondaryRateLimit: (
      retryAfter: number,
      options: Record<string, unknown>,
      _octokit: any,
      retryCount: number,
    ): boolean => {
      gitHubThrottleMetrics.secondaryRateLimitsTotal++;
      gitHubThrottleMetrics.totalThrottledRequests++;
      gitHubThrottleMetrics.lastThrottledAt = new Date().toISOString();
      gitHubThrottleMetrics.lastRetryAfterSeconds = retryAfter;

      const safeOpts = sanitizeRequestOptionsForLogging(options);
      log.warn(
        `[GitHub Secondary Rate Limit] Secondary limit hit for ${safeOpts.method} ${safeOpts.url}. Retry ${retryCount}/${maxRetries} after ${retryAfter}s.`,
        safeOpts,
      );

      configOptions.onSecondaryRateLimitCallback?.(retryAfter, options);

      if (retryCount < maxRetries && retryAfter <= maxRetryAfter) {
        return true;
      }
      return false;
    },
  };
}

/**
 * An Octokit class with the throttling plugin attached.
 */
export const ThrottledOctokit = Octokit.plugin(throttling);

/**
 * Custom error indicating a job failed due to GitHub API rate limiting
 * and should be backed off / delayed in the queue rather than routed to DLQ.
 */
export class GitHubRateLimitError extends Error {
  public readonly retryAfterSeconds: number;
  public readonly isSecondary: boolean;

  constructor(message: string, retryAfterSeconds = 60, isSecondary = false) {
    super(message);
    this.name = "GitHubRateLimitError";
    this.retryAfterSeconds = retryAfterSeconds;
    this.isSecondary = isSecondary;
  }
}

/**
 * Checks whether an error is a GitHub API rate limit error (status 403 or 429 with rate limit messages/headers).
 */
export function isGitHubApiRateLimitError(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;

  if (err instanceof GitHubRateLimitError) return true;

  const errorObj = err as any;
  const status = errorObj.status ?? errorObj.statusCode ?? errorObj.response?.status;
  const message = String(errorObj.message || "").toLowerCase();

  // Primary rate limit: 403 with 'rate limit' in message, or x-ratelimit-remaining == '0'
  if (status === 403) {
    if (
      message.includes("rate limit") ||
      message.includes("secondary rate limit") ||
      message.includes("api rate limit exceeded") ||
      message.includes("abuse detection mechanism")
    ) {
      return true;
    }
    const headers = errorObj.response?.headers;
    if (headers && (headers["x-ratelimit-remaining"] === "0" || headers["retry-after"])) {
      return true;
    }
  }

  // 429: Too Many Requests
  if (status === 429) {
    return true;
  }

  return false;
}

/**
 * Extracts retry-after delay (in milliseconds) from a GitHub rate limit error, defaulting to 60s.
 */
export function extractGitHubRetryAfterMs(err: unknown, defaultMs = 60_000): number {
  if (err instanceof GitHubRateLimitError) {
    return Math.max(1_000, err.retryAfterSeconds * 1_000);
  }

  const errorObj = err as any;
  const headers = errorObj?.response?.headers;

  if (headers?.["retry-after"]) {
    const parsed = parseInt(String(headers["retry-after"]), 10);
    if (!isNaN(parsed) && parsed > 0) {
      return Math.min(parsed * 1000, 300_000); // capped at 5 minutes
    }
  }

  if (headers?.["x-ratelimit-reset"]) {
    const resetTimeSec = parseInt(String(headers["x-ratelimit-reset"]), 10);
    if (!isNaN(resetTimeSec) && resetTimeSec > 0) {
      const waitMs = resetTimeSec * 1000 - Date.now();
      if (waitMs > 0) {
        return Math.min(waitMs + 1000, 300_000);
      }
    }
  }

  return defaultMs;
}
