import NextAuth from 'next-auth';
import authConfig from './auth.config';
import { NextRequest, NextResponse } from 'next/server';
import { getApiRateLimiter } from '@/lib/rate-limit';
import { getClientIp } from '@/lib/client-ip';
import { classifyApiPath, rateLimitHeaders } from '@/lib/api-rate-limit-policy';
import { applySecurityHeaders, securityHeaderOptionsFromEnv } from '@/lib/security-headers';

const { auth } = NextAuth(authConfig);

/**
 * Attach the security headers to a response middleware builds itself (#559).
 *
 * `next.config.ts` `headers()` covers everything that reaches the routing
 * layer, but a middleware short-circuit — the admin guard's 401/403/redirects,
 * the rate limiter's 429 — returns before that layer runs, and would otherwise
 * be the only responses in the application served bare.
 *
 * Deliberately *not* applied to `NextResponse.next()`: that response carries on
 * to the routing layer and would end up with two `Content-Security-Policy`
 * headers. A browser intersects multiple CSP headers, so the duplicate is not
 * merely redundant — it silently yields a policy stricter than either alone.
 */
function secured(response: NextResponse): NextResponse {
  return applySecurityHeaders(response, securityHeaderOptionsFromEnv());
}

export default auth(async function middleware(
  request: NextRequest & {
    auth?: {
      user?: { roles?: string[] };
      roles?: string[];
    } | null;
  }
) {
  const token = request.auth;

  // 1. DoS protection on /api, by class rather than one global bucket (#644).
  //
  // `classifyApiPath` decides which budget applies. `/api/webhooks/github` and
  // the health probes are exempt: they carry their own authentication and their
  // own controls, and putting GitHub's delivery IPs in a shared 20/min bucket
  // meant a busy minute silently lost scans to a 429 GitHub never retries.
  const rateLimitClass = classifyApiPath(request.nextUrl.pathname);

  if (rateLimitClass !== 'exempt') {
    const limiter = getApiRateLimiter(rateLimitClass);

    if (limiter) {
      // Derived from the trusted portion of X-Forwarded-For — see getClientIp
      // and the TRUSTED_PROXY_HOP_COUNT setting. Reading a client-supplied
      // header here would let a caller mint a fresh bucket on every request.
      const ip = getClientIp(request.headers);
      const decision = await limiter.limit(ip);

      if (!decision.success) {
        return secured(
          NextResponse.json(
            { error: 'Too Many Requests', message: 'Rate limit exceeded' },
            {
              status: 429,
              // The route-level `withRateLimit` has always emitted these; the
              // middleware emitted none of them, so the two paths disagreed
              // about whether a caller could learn when to retry.
              headers: rateLimitHeaders(decision),
            }
          )
        );
      }
    }
  }

  // 2. RBAC Admin Route Guarding (/admin/* and /api/admin/*)
  const isAdminWebRoute = request.nextUrl.pathname.startsWith('/admin');
  const isAdminApiRoute = request.nextUrl.pathname.startsWith('/api/admin');

  if (isAdminWebRoute || isAdminApiRoute) {
    if (process.env.NEXT_PUBLIC_MOCK_AUTH === 'true') {
      const mockSession = request.cookies.get('mock-session')?.value;
      if (mockSession === 'admin') {
        return NextResponse.next();
      }
      if (isAdminApiRoute) {
        return secured(
          NextResponse.json(
            { error: 'Unauthorized', message: 'Forbidden' },
            { status: mockSession === 'user' ? 403 : 401 }
          )
        );
      }
      if (mockSession === 'user') {
        return secured(NextResponse.redirect(new URL('/dashboard', request.nextUrl)));
      }
      return secured(NextResponse.redirect(new URL('/login', request.nextUrl)));
    }

    const roles: string[] =
      (token?.user?.roles as string[]) || (token?.roles as string[]) || [];

    if (!token) {
      if (isAdminApiRoute) {
        return secured(
          NextResponse.json(
            { error: 'Unauthorized', message: 'Authentication required' },
            { status: 401 }
          )
        );
      }
      return secured(NextResponse.redirect(new URL('/login', request.nextUrl)));
    }

    if (!roles.includes('ADMIN')) {
      if (isAdminApiRoute) {
        return secured(
          NextResponse.json(
            { error: 'Forbidden', message: 'Admin role required' },
            { status: 403 }
          )
        );
      }
      return secured(NextResponse.redirect(new URL('/dashboard', request.nextUrl)));
    }
  }

  // 3. Codename Onboarding Interception ("The Naming Ceremony") (#185)
  const isCodenameSetupRoute = request.nextUrl.pathname === '/setup/codename';
  const isDashboardRoute = request.nextUrl.pathname.startsWith('/dashboard');

  if (process.env.NEXT_PUBLIC_MOCK_AUTH === 'true') {
    const mockSession = request.cookies.get('mock-session')?.value;
    if (isCodenameSetupRoute) {
      if (!mockSession || mockSession === 'none') {
        return secured(NextResponse.redirect(new URL('/login', request.nextUrl)));
      }
      if (mockSession === 'admin' || mockSession === 'user') {
        return secured(NextResponse.redirect(new URL('/dashboard', request.nextUrl)));
      }
      return NextResponse.next();
    }
    if (isDashboardRoute && (mockSession === 'no-codename' || mockSession === 'recruit')) {
      return secured(NextResponse.redirect(new URL('/setup/codename', request.nextUrl)));
    }
  } else {
    const userCodename = (token?.user as any)?.codename || (token as any)?.codename;

    if (isCodenameSetupRoute) {
      if (!token) {
        return secured(NextResponse.redirect(new URL('/login', request.nextUrl)));
      }
      if (userCodename) {
        return secured(NextResponse.redirect(new URL('/dashboard', request.nextUrl)));
      }
      return NextResponse.next();
    }

    if (isDashboardRoute && token && !userCodename) {
      return secured(NextResponse.redirect(new URL('/setup/codename', request.nextUrl)));
    }
  }

  return NextResponse.next();
});

export const config = {
  // 3. Matcher Update: Removed 'api|' from the negative lookahead
  // This ensures the middleware actually triggers on all /api/ requests
  matcher: ['/((?!_next/static|_next/image|favicon.ico).*)'],
};