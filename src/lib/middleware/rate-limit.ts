import { NextRequest, NextResponse } from 'next/server';
import { checkRateLimit, FallbackStrategy } from '../redis';
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

    let isAllowed: boolean;
    try {
      isAllowed = await checkRateLimit(key, config.limit, config.windowSeconds, {
        fallbackStrategy: config.fallbackStrategy ?? 'fail-open',
        timeoutMs: config.timeoutMs,
      });
    } catch (err) {
      console.error('Rate limiting middleware error:', err);
      // Fail open by default if an unexpected exception escapes
      isAllowed = config.fallbackStrategy !== 'fail-closed';
    }

    if (!isAllowed) {
      return NextResponse.json(
        { error: 'Too Many Requests', message: 'You have exceeded the rate limit. Please try again later.' },
        { status: 429, headers: { 'Retry-After': config.windowSeconds.toString() } }
      );
    }

    return handler(req, ...args);
  };
}
