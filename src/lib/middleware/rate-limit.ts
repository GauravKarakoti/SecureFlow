import { NextRequest, NextResponse } from 'next/server';
import { checkRateLimitDetailed, FallbackStrategy, RateLimitResult } from '../redis';
import { getClientIp } from '../client-ip';

export interface RateLimitConfig {
  limit: number;
  windowSeconds: number;
  keyPrefix: string;
  fallbackStrategy?: FallbackStrategy;
  timeoutMs?: number;
}

/**
 * Tiered rate-limit presets.
 *
 * AUTH        — login/OAuth endpoints: tight window, fail-closed to block credential stuffing.
 * AI_STREAM   — resource-heavy LLM streaming: low quota, fail-closed to protect Groq spend.
 * AI_STREAM_USER — per-user inner guard for AI streaming (used alongside IP tier).
 * STANDARD    — normal data-fetching routes: generous quota, fail-open for resilience.
 * ADMIN       — admin-only routes: moderate quota, fail-closed.
 */
export const TIERS = {
  AUTH:           { limit: 10,  windowSeconds: 60,  fallbackStrategy: 'fail-closed' as FallbackStrategy, timeoutMs: 1000 },
  AI_STREAM:      { limit: 20,  windowSeconds: 60,  fallbackStrategy: 'fail-closed' as FallbackStrategy, timeoutMs: 1000 },
  AI_STREAM_USER: { limit: 10,  windowSeconds: 60,  fallbackStrategy: 'fail-closed' as FallbackStrategy, timeoutMs: 1000 },
  STANDARD:       { limit: 120, windowSeconds: 60,  fallbackStrategy: 'fail-open'   as FallbackStrategy },
  ADMIN:          { limit: 30,  windowSeconds: 60,  fallbackStrategy: 'fail-closed' as FallbackStrategy, timeoutMs: 1000 },
} as const;

/** Seconds remaining until the window rolls over, floored at 1 so we never say "retry in 0s". */
export function secondsUntilReset(resetAt: number, now: number = Date.now()): number {
  return Math.max(1, Math.ceil((resetAt - now) / 1000));
}

/**
 * Standard rate-limit headers for a decision.
 *
 * `X-RateLimit-Reset` is expressed in epoch seconds, matching the convention used
 * by the GitHub API that this project already talks to.
 */
export function buildRateLimitHeaders(result: RateLimitResult): Record<string, string> {
  return {
    'X-RateLimit-Limit': String(result.limit),
    'X-RateLimit-Remaining': String(result.remaining),
    'X-RateLimit-Reset': String(Math.ceil(result.resetAt / 1000)),
  };
}

export function withRateLimit(
  handler: (req: NextRequest, ...args: any[]) => Promise<NextResponse>,
  config: RateLimitConfig
) {
  return async (req: NextRequest, ...args: any[]) => {
    // Resolve a single client IP rather than the raw, client-appendable
    // X-Forwarded-For string (see getClientIp), so the limit can't be bypassed
    // by varying the header.
    const ip = getClientIp(req.headers);
    const key = `rate-limit:${config.keyPrefix}:${ip}`;

    let result: RateLimitResult;
    try {
      result = await checkRateLimitDetailed(key, config.limit, config.windowSeconds, {
        fallbackStrategy: config.fallbackStrategy ?? 'fail-open',
        timeoutMs: config.timeoutMs,
      });
    } catch (err) {
      console.error('Rate limiting middleware error:', err);
      // Fail open by default if an unexpected exception escapes
      const allowed = config.fallbackStrategy !== 'fail-closed';
      result = {
        allowed,
        limit: config.limit,
        remaining: allowed ? config.limit : 0,
        resetAt: Date.now() + config.windowSeconds * 1000,
        degraded: true,
      };
    }

    if (!result.allowed) {
      return NextResponse.json(
        { error: 'Too Many Requests', message: 'You have exceeded the rate limit. Please try again later.' },
        {
          status: 429,
          headers: {
            ...buildRateLimitHeaders(result),
            // The real time left in the window, not the full window length. A
            // caller blocked one second into a 60s window was previously told to
            // wait the whole 60 seconds.
            'Retry-After': String(secondsUntilReset(result.resetAt)),
          },
        }
      );
    }

    const response = await handler(req, ...args);

    // Advertise the budget on successful responses so clients can back off before
    // being blocked. Skipped when the decision came from the fallback strategy,
    // since the numbers would be invented rather than measured.
    if (!result.degraded && response && typeof (response as NextResponse).headers?.set === 'function') {
      for (const [header, value] of Object.entries(buildRateLimitHeaders(result))) {
        response.headers.set(header, value);
      }
    }

    return response;
  };
}
