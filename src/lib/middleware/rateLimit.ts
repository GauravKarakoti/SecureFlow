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
