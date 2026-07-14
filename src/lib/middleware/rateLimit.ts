import { NextRequest, NextResponse } from 'next/server';
import { checkRateLimit } from '../redis';
import { getClientIp } from '../client-ip';

export function withRateLimit(
  handler: (req: NextRequest, ...args: any[]) => Promise<NextResponse>,
  config: { limit: number; windowSeconds: number; keyPrefix: string }
) {
  return async (req: NextRequest, ...args: any[]) => {
    // Resolve a single client IP rather than the raw, client-appendable
    // X-Forwarded-For string (see getClientIp), so the limit can't be bypassed
    // by varying the header.
    const ip = getClientIp(req.headers);
    const key = `rate-limit:${config.keyPrefix}:${ip}`;

    const isAllowed = await checkRateLimit(key, config.limit, config.windowSeconds);

    if (!isAllowed) {
      return NextResponse.json(
        { error: 'Too Many Requests', message: 'You have exceeded the rate limit. Please try again later.' },
        { status: 429, headers: { 'Retry-After': config.windowSeconds.toString() } }
      );
    }

    return handler(req, ...args);
  };
}
