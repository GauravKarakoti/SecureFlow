/**
 * Middleware rate-limiting behaviour (#644).
 *
 * `src/proxy.test.ts` covers the RBAC and codename guards with the limiter
 * disabled (`ratelimit: null`). This file is the other half: the limiter is
 * stubbed to a controllable decision so the classification, the exemptions and
 * the 429 headers can be asserted through the real middleware.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { NextRequest, NextResponse } from 'next/server';
import type { LimitedApiRateLimitClass } from '@/lib/api-rate-limit-policy';

type MockAuthRequest = NextRequest & {
  auth?: { user?: { roles?: string[]; codename?: string } } | null;
};

vi.mock('next-auth', () => ({
  default: vi.fn(() => ({
    auth:
      (handler: (req: MockAuthRequest) => Promise<NextResponse>) =>
      async (req: MockAuthRequest) =>
        handler(req),
  })),
}));

vi.mock('@/lib/client-ip', () => ({
  getClientIp: () => '203.0.113.9',
}));

/** Records which class was asked for, so exemptions can be asserted by absence. */
const requestedClasses: LimitedApiRateLimitClass[] = [];
const limitMock = vi.fn();

vi.mock('@/lib/rate-limit', () => ({
  getApiRateLimiter: (className: LimitedApiRateLimitClass) => {
    requestedClasses.push(className);
    return { limit: limitMock };
  },
}));

const rawMiddleware = (await import('./proxy')).default;
const middleware = rawMiddleware as unknown as (
  req: MockAuthRequest
) => Promise<NextResponse | undefined>;

/** An allowed decision with a window rolling over 30 seconds from now. */
function allowed(remaining = 5) {
  return { success: true, limit: 20, remaining, reset: Date.now() + 30_000 };
}

function blocked() {
  return { success: false, limit: 20, remaining: 0, reset: Date.now() + 30_000 };
}

function request(path: string): MockAuthRequest {
  const req = new NextRequest(`http://localhost${path}`) as MockAuthRequest;
  req.auth = null;
  return req;
}

const ORIGINAL_ENV = process.env;

beforeEach(() => {
  requestedClasses.length = 0;
  limitMock.mockReset();
  limitMock.mockResolvedValue(allowed());
  process.env = { ...ORIGINAL_ENV, NEXT_PUBLIC_MOCK_AUTH: 'false' };
});

afterEach(() => {
  process.env = ORIGINAL_ENV;
});

describe('middleware rate limiting — exemptions', () => {
  it('never limits the GitHub webhook endpoint', async () => {
    // The whole point of the issue: GitHub delivers from a small pool of
    // addresses, and a 429 is recorded as a failed delivery it will not retry.
    const res = await middleware(request('/api/webhooks/github'));

    expect(limitMock).not.toHaveBeenCalled();
    expect(res?.status).toBe(200);
  });

  it('never limits the health probes', async () => {
    await middleware(request('/api/health'));
    await middleware(request('/api/ready'));

    expect(limitMock).not.toHaveBeenCalled();
  });

  it('does not limit page routes', async () => {
    await middleware(request('/dashboard'));

    expect(limitMock).not.toHaveBeenCalled();
  });
});

describe('middleware rate limiting — classification', () => {
  it('uses the auth class for NextAuth routes', async () => {
    await middleware(request('/api/auth/session'));

    expect(requestedClasses).toEqual(['auth']);
    expect(limitMock).toHaveBeenCalledWith('203.0.113.9');
  });

  it('uses the stream class for the AI routes', async () => {
    await middleware(request('/api/heist-transmission?project=Vault'));

    expect(requestedClasses).toEqual(['stream']);
  });

  it('uses the standard class for everything else', async () => {
    await middleware(request('/api/leaderboard'));

    expect(requestedClasses).toEqual(['standard']);
  });

  it('keys the bucket on the trusted client IP, not a request header', async () => {
    await middleware(request('/api/leaderboard'));

    expect(limitMock).toHaveBeenCalledWith('203.0.113.9');
  });
});

describe('middleware rate limiting — the 429', () => {
  it('returns 429 when the limiter blocks', async () => {
    limitMock.mockResolvedValue(blocked());

    const res = await middleware(request('/api/leaderboard'));

    expect(res?.status).toBe(429);
    await expect(res?.json()).resolves.toMatchObject({ error: 'Too Many Requests' });
  });

  it('carries Retry-After and the X-RateLimit triple', async () => {
    // The route-level `withRateLimit` has always emitted these; the middleware
    // emitted none of them, so a client could not learn when to retry from the
    // path that actually fires for most requests.
    limitMock.mockResolvedValue(blocked());

    const res = await middleware(request('/api/leaderboard'));

    expect(res?.headers.get('Retry-After')).toBe('30');
    expect(res?.headers.get('X-RateLimit-Limit')).toBe('20');
    expect(res?.headers.get('X-RateLimit-Remaining')).toBe('0');
    expect(res?.headers.get('X-RateLimit-Reset')).toBeTruthy();
  });

  it('still carries the security headers', async () => {
    // A middleware short-circuit returns before the routing layer's headers()
    // runs, so it would otherwise be the only bare response in the app (#559).
    limitMock.mockResolvedValue(blocked());

    const res = await middleware(request('/api/leaderboard'));

    expect(res?.headers.get('Content-Security-Policy')).toBeTruthy();
  });

  it('lets an allowed request continue to the routing layer', async () => {
    const res = await middleware(request('/api/leaderboard'));

    expect(res?.status).toBe(200);
    expect(res?.headers.get('Retry-After')).toBeNull();
  });

  it('blocks the auth class independently of the standard class', async () => {
    // Distinct prefixes mean a burst of dashboard fetches cannot consume the
    // budget an OAuth callback needs.
    limitMock.mockResolvedValueOnce(blocked()).mockResolvedValueOnce(allowed());

    const first = await middleware(request('/api/leaderboard'));
    const second = await middleware(request('/api/auth/callback/github'));

    expect(first?.status).toBe(429);
    expect(second?.status).toBe(200);
    expect(requestedClasses).toEqual(['standard', 'auth']);
  });
});
