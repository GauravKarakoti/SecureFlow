import { NextRequest, NextResponse } from 'next/server';
import { checkRateLimit } from '../redis';

export function withRateLimit(
  handler: (req: NextRequest, ...args: any[]) => Promise<NextResponse>,
  config: { limit: number; windowSeconds: number; keyPrefix: string }
) {
  return async (req: NextRequest, ...args: any[]) => {
    // Extract IP address from standard headers (Vercel, Cloudflare, Nginx, etc.)
    const ip = req.headers.get('x-forwarded-for') ?? '127.0.0.1';
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
