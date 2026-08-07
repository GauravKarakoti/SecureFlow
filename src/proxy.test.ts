import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { NextRequest, NextResponse } from 'next/server';

type MockAuthRequest = NextRequest & {
  auth?: {
    user?: { id?: string; name?: string; roles?: string[] };
    roles?: string[];
  } | null;
};

// Mock NextAuth to return an auth wrapper that passes request to handler
vi.mock('next-auth', () => ({
  default: vi.fn(() => ({
    auth: (handler: (req: MockAuthRequest) => Promise<NextResponse>) => async (req: MockAuthRequest) => handler(req),
  })),
}));

// Mock ratelimit modules to prevent side effects
vi.mock('@/lib/ratelimit', () => ({
  ratelimit: null,
}));

vi.mock('@/lib/client-ip', () => ({
  getClientIp: () => '127.0.0.1',
}));

import rawMiddleware from './proxy';
const middleware = rawMiddleware as unknown as (req: MockAuthRequest, ctx?: unknown) => Promise<NextResponse | undefined>;

describe('Next.js RBAC Middleware Guarding', () => {
  const ORIGINAL_ENV = process.env;

  beforeEach(() => {
    vi.clearAllMocks();
    process.env = { ...ORIGINAL_ENV, NEXT_PUBLIC_MOCK_AUTH: 'false' };
  });

  afterEach(() => {
    process.env = ORIGINAL_ENV;
  });

  it('allows access to non-admin routes for any request', async () => {
    const req = new NextRequest('http://localhost/dashboard') as MockAuthRequest;
    req.auth = null;

    const res = await middleware(req);

    expect(res).toBeDefined();
    expect(res?.status).toBe(200); // NextResponse.next()
  });

  it('redirects unauthenticated users attempting to access /admin/* to /login', async () => {
    const req = new NextRequest('http://localhost/admin/users') as MockAuthRequest;
    req.auth = null;

    const res = await middleware(req);

    expect(res).toBeDefined();
    expect(res?.status).toBe(307);
    expect(res?.headers.get('location')).toBe('http://localhost/login');
  });

  it('redirects non-admin users attempting to access /admin/* to /dashboard', async () => {
    const req = new NextRequest('http://localhost/admin/queue') as MockAuthRequest;
    req.auth = {
      user: {
        id: 'user-123',
        name: 'Standard User',
        roles: ['USER'],
      },
    };

    const res = await middleware(req);

    expect(res).toBeDefined();
    expect(res?.status).toBe(307);
    expect(res?.headers.get('location')).toBe('http://localhost/dashboard');
  });

  it('allows admin users with ADMIN role to access /admin/*', async () => {
    const req = new NextRequest('http://localhost/admin/logs') as MockAuthRequest;
    req.auth = {
      user: {
        id: 'admin-123',
        name: 'Admin User',
        roles: ['ADMIN', 'USER'],
      },
    };

    const res = await middleware(req);

    expect(res).toBeDefined();
    expect(res?.status).toBe(200); // NextResponse.next()
  });

  it('supports roles directly on auth token if not under user property', async () => {
    const req = new NextRequest('http://localhost/admin/users') as MockAuthRequest;
    req.auth = {
      roles: ['ADMIN'],
    };

    const res = await middleware(req);

    expect(res).toBeDefined();
    expect(res?.status).toBe(200); // NextResponse.next()
  });

  describe('Mock Auth Environment (NEXT_PUBLIC_MOCK_AUTH=true)', () => {
    beforeEach(() => {
      process.env.NEXT_PUBLIC_MOCK_AUTH = 'true';
    });

    it('allows access to /admin/* when mock-session cookie is "admin"', async () => {
      const req = new NextRequest('http://localhost/admin/queue', {
        headers: { cookie: 'mock-session=admin' },
      }) as MockAuthRequest;
      req.auth = null;

      const res = await middleware(req);

      expect(res).toBeDefined();
      expect(res?.status).toBe(200);
    });

    it('redirects to /dashboard when mock-session cookie is "user"', async () => {
      const req = new NextRequest('http://localhost/admin/users', {
        headers: { cookie: 'mock-session=user' },
      }) as MockAuthRequest;
      req.auth = null;

      const res = await middleware(req);

      expect(res).toBeDefined();
      expect(res?.status).toBe(307);
      expect(res?.headers.get('location')).toBe('http://localhost/dashboard');
    });

    it('redirects to /login when mock-session cookie is missing or invalid', async () => {
      const req = new NextRequest('http://localhost/admin/logs', {
        headers: { cookie: 'mock-session=none' },
      }) as MockAuthRequest;
      req.auth = null;

      const res = await middleware(req);

      expect(res).toBeDefined();
      expect(res?.status).toBe(307);
      expect(res?.headers.get('location')).toBe('http://localhost/login');
    });
  });
});
