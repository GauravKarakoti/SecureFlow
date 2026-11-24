import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  createThrottleConfig,
  getGitHubThrottleMetrics,
  resetGitHubThrottleMetrics,
  sanitizeRequestOptionsForLogging,
  isGitHubApiRateLimitError,
  extractGitHubRetryAfterMs,
  GitHubRateLimitError,
} from "./throttling";

describe("GitHub Throttling & Rate Limit Resilience (#2014)", () => {
  beforeEach(() => {
    resetGitHubThrottleMetrics();
  });

  describe("sanitizeRequestOptionsForLogging", () => {
    it("redacts tokens, authorization headers and strips bodies from logs", () => {
      const sanitized = sanitizeRequestOptionsForLogging({
        method: "POST",
        url: "/repos/acme/repo/pulls/1?access_token=secret123",
        headers: {
          authorization: "Bearer secret-token-xyz",
          "x-custom": "public-value",
          "github-token": "ghp_abc123",
        },
        body: JSON.stringify({ sensitive: "data" }),
      });

      expect(sanitized.method).toBe("POST");
      expect(sanitized.url).toBe("/repos/acme/repo/pulls/1?access_token=[REDACTED]");
      expect(sanitized.hasPayload).toBe(true);
      expect((sanitized as any).body).toBeUndefined();
    });
  });

  describe("createThrottleConfig", () => {
    it("handles onRateLimit (primary limit) by counting metrics and allowing retry within bounds", () => {
      const onRateLimitCallback = vi.fn();
      const throttle = createThrottleConfig({
        maxRetries: 3,
        maxRetryAfterSeconds: 60,
        onRateLimitCallback,
      });

      const options = { method: "GET", url: "/repos/acme/repo" };

      // Attempt 1 with retryAfter: 10s -> should retry (return true)
      const shouldRetry1 = throttle.onRateLimit(10, options, {}, 1);
      expect(shouldRetry1).toBe(true);
      expect(onRateLimitCallback).toHaveBeenCalledWith(10, options);

      // Attempt 4 (exceeds maxRetries = 3) -> should not retry (return false)
      const shouldRetryMax = throttle.onRateLimit(10, options, {}, 4);
      expect(shouldRetryMax).toBe(false);

      // Attempt with retryAfter: 120s (exceeds maxRetryAfter = 60s) -> should not retry
      const shouldRetryLong = throttle.onRateLimit(120, options, {}, 1);
      expect(shouldRetryLong).toBe(false);

      // Verify metrics
      const metrics = getGitHubThrottleMetrics();
      expect(metrics.primaryRateLimitsTotal).toBe(3);
      expect(metrics.secondaryRateLimitsTotal).toBe(0);
      expect(metrics.totalThrottledRequests).toBe(3);
      expect(metrics.lastRetryAfterSeconds).toBe(120);
      expect(metrics.lastThrottledAt).toBeDefined();
    });

    it("handles onSecondaryRateLimit (abuse/secondary limit) by counting metrics and allowing retry within bounds", () => {
      const onSecondaryCallback = vi.fn();
      const throttle = createThrottleConfig({
        maxRetries: 2,
        maxRetryAfterSeconds: 30,
        onSecondaryRateLimitCallback: onSecondaryCallback,
      });

      const options = { method: "POST", url: "/repos/acme/repo/issues/1/comments" };

      // Within limits
      const shouldRetry = throttle.onSecondaryRateLimit(15, options, {}, 1);
      expect(shouldRetry).toBe(true);
      expect(onSecondaryCallback).toHaveBeenCalledWith(15, options);

      // Exceeds max retries
      const shouldFail = throttle.onSecondaryRateLimit(15, options, {}, 2);
      expect(shouldFail).toBe(false);

      const metrics = getGitHubThrottleMetrics();
      expect(metrics.secondaryRateLimitsTotal).toBe(2);
      expect(metrics.primaryRateLimitsTotal).toBe(0);
      expect(metrics.totalThrottledRequests).toBe(2);
    });
  });

  describe("isGitHubApiRateLimitError", () => {
    it("detects GitHubRateLimitError instance", () => {
      const err = new GitHubRateLimitError("Rate limited", 30);
      expect(isGitHubApiRateLimitError(err)).toBe(true);
    });

    it("simulates and detects 429 Too Many Requests response", () => {
      const err429 = { status: 429, message: "Too Many Requests" };
      expect(isGitHubApiRateLimitError(err429)).toBe(true);

      const errResponse429 = { response: { status: 429 } };
      expect(isGitHubApiRateLimitError(errResponse429)).toBe(true);
    });

    it("simulates and detects 403 primary and secondary rate limits", () => {
      const primary403 = {
        status: 403,
        message: "API rate limit exceeded for user ID 123",
      };
      expect(isGitHubApiRateLimitError(primary403)).toBe(true);

      const secondary403 = {
        status: 403,
        message:
          "You have exceeded a secondary rate limit. Please wait a few minutes before you try again.",
      };
      expect(isGitHubApiRateLimitError(secondary403)).toBe(true);

      const abuse403 = {
        status: 403,
        message:
          "Please wait a few minutes before you try again. If you continue to see this error, check the abuse detection mechanism.",
      };
      expect(isGitHubApiRateLimitError(abuse403)).toBe(true);

      const header403 = {
        status: 403,
        message: "Forbidden",
        response: {
          headers: {
            "x-ratelimit-remaining": "0",
          },
        },
      };
      expect(isGitHubApiRateLimitError(header403)).toBe(true);
    });

    it("returns false for non-rate-limit 403 (e.g. permission denied) and other errors", () => {
      const permDenied = {
        status: 403,
        message: "Resource not accessible by integration",
      };
      expect(isGitHubApiRateLimitError(permDenied)).toBe(false);

      const err500 = { status: 500, message: "Internal server error" };
      expect(isGitHubApiRateLimitError(err500)).toBe(false);

      expect(isGitHubApiRateLimitError(null)).toBe(false);
      expect(isGitHubApiRateLimitError(undefined)).toBe(false);
    });
  });

  describe("extractGitHubRetryAfterMs", () => {
    it("extracts delay from GitHubRateLimitError", () => {
      const err = new GitHubRateLimitError("Rate limited", 25);
      expect(extractGitHubRetryAfterMs(err)).toBe(25_000);
    });

    it("extracts retry-after header", () => {
      const err = {
        status: 429,
        response: {
          headers: {
            "retry-after": "45",
          },
        },
      };
      expect(extractGitHubRetryAfterMs(err)).toBe(45_000);
    });

    it("extracts x-ratelimit-reset header", () => {
      const futureResetSec = Math.floor(Date.now() / 1000) + 15;
      const err = {
        status: 403,
        response: {
          headers: {
            "x-ratelimit-reset": String(futureResetSec),
          },
        },
      };
      const delay = extractGitHubRetryAfterMs(err);
      expect(delay).toBeGreaterThanOrEqual(14_000);
      expect(delay).toBeLessThanOrEqual(17_000);
    });

    it("falls back to default delay when no headers exist", () => {
      const err = { status: 429 };
      expect(extractGitHubRetryAfterMs(err, 30_000)).toBe(30_000);
    });
  });
});
