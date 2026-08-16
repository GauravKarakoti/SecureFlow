import NextAuth from 'next-auth';
import authConfig from './auth.config';
import { NextRequest, NextResponse } from 'next/server';
import { ratelimit } from '@/lib/rate-limit';
import { getClientIp } from '@/lib/client-ip';

const { auth } = NextAuth(authConfig);

export default auth(async function middleware(
  request: NextRequest & {
    auth?: {
      user?: { roles?: string[] };
      roles?: string[];
    } | null;
  }
) {
  const token = request.auth;
  
  if (request.nextUrl.pathname.startsWith('/api/og') && ratelimit) {
    // Derived from the trusted portion of X-Forwarded-For — see getClientIp and
    // the TRUSTED_PROXY_HOP_COUNT setting. Reading a client-supplied header here
    // would let a caller mint a fresh bucket on every request.
    const ip = getClientIp(request.headers);
    const { success } = await ratelimit.limit(ip);
    
    if (!success) {
      return new NextResponse('Too Many Requests', { status: 429 });
    }
  }
  
  // RBAC Admin Route Guarding (/admin/* and /api/admin/*)
  const isAdminWebRoute = request.nextUrl.pathname.startsWith('/admin');
  const isAdminApiRoute = request.nextUrl.pathname.startsWith('/api/admin');

  if (isAdminWebRoute || isAdminApiRoute) {
    if (process.env.NEXT_PUBLIC_MOCK_AUTH === 'true') {
      const mockSession = request.cookies.get('mock-session')?.value;
      if (mockSession === 'admin') {
        return NextResponse.next();
      }
      if (isAdminApiRoute) {
        return NextResponse.json(
          { error: 'Unauthorized', message: 'Forbidden' },
          { status: mockSession === 'user' ? 403 : 401 }
        );
      }
      if (mockSession === 'user') {
        return NextResponse.redirect(new URL('/dashboard', request.nextUrl));
      }
      return NextResponse.redirect(new URL('/login', request.nextUrl));
    }

    const roles: string[] =
      (token?.user?.roles as string[]) || (token?.roles as string[]) || [];

    if (!token) {
      if (isAdminApiRoute) {
        return NextResponse.json(
          { error: 'Unauthorized', message: 'Authentication required' },
          { status: 401 }
        );
      }
      return NextResponse.redirect(new URL('/login', request.nextUrl));
    }

    if (!roles.includes('ADMIN')) {
      if (isAdminApiRoute) {
        return NextResponse.json(
          { error: 'Forbidden', message: 'Admin role required' },
          { status: 403 }
        );
      }
      return NextResponse.redirect(new URL('/dashboard', request.nextUrl));
    }
  }

  return NextResponse.next();
});

export const config = {
  matcher: ['/admin/:path*', '/api/admin/:path*', '/((?!api|_next/static|_next/image|favicon.ico).*)'],
};
