import NextAuth from 'next-auth';
import authConfig from './auth.config';
import { NextRequest, NextResponse } from 'next/server';
import { ratelimit } from '@/lib/rate-limit';
import { getClientIp } from '@/lib/client-ip';
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
  
  // 1. Blanket DoS Protection: Rate limit ALL /api routes
  if (request.nextUrl.pathname.startsWith('/api') && ratelimit) {
    // Derived from the trusted portion of X-Forwarded-For — see getClientIp and
    // the TRUSTED_PROXY_HOP_COUNT setting. Reading a client-supplied header here
    // would let a caller mint a fresh bucket on every request.
    const ip = getClientIp(request.headers);
    const { success } = await ratelimit.limit(ip);
    
    if (!success) {
      return secured(new NextResponse(
        JSON.stringify({ error: 'Too Many Requests', message: 'Rate limit exceeded' }), 
        { 
          status: 429,
          headers: { 'Content-Type': 'application/json' }
        }
      ));
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

  return NextResponse.next();
});

export const config = {
  // 3. Matcher Update: Removed 'api|' from the negative lookahead
  // This ensures the middleware actually triggers on all /api/ requests
  matcher: ['/((?!_next/static|_next/image|favicon.ico).*)'],
};