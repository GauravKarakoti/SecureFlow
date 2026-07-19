import NextAuth from 'next-auth';
import authConfig from './auth.config';
import { NextResponse } from 'next/server';
import { ratelimit } from '@/lib/ratelimit';
import { getClientIp } from '@/lib/client-ip';

const { auth } = NextAuth(authConfig);

export default auth(async function middleware(request: any) {
  const token = request.auth;
  
  if (request.nextUrl.pathname.startsWith('/api/og') && ratelimit) {
    const ip = getClientIp(request.headers);
    const { success } = await ratelimit.limit(ip);
    
    if (!success) {
      return new NextResponse('Too Many Requests', { status: 429 });
    }
  }
  
  let hasSession = !!token?.user;
  let hasCodename = !!token?.user?.codename;

  if (process.env.NEXT_PUBLIC_MOCK_AUTH === 'true') {
    const mockSession = request.cookies.get("mock-session")?.value;
    if (mockSession === "admin" || mockSession === "user") {
      hasSession = true;
      hasCodename = true;
    } else if (mockSession === "nocodename") {
      hasSession = true;
      hasCodename = false;
    }
  }

  const isSetupCodename = request.nextUrl.pathname === '/setup/codename';

  if (!hasSession && isSetupCodename) {
    return NextResponse.redirect(new URL('/login', request.nextUrl));
  }

  if (hasSession && !hasCodename && !isSetupCodename) {
    const isTargetRoute = 
      request.nextUrl.pathname.startsWith('/dashboard') || 
      request.nextUrl.pathname.startsWith('/admin') ||
      request.nextUrl.pathname.startsWith('/setup');

    if (isTargetRoute) {
      return NextResponse.redirect(new URL('/setup/codename', request.nextUrl));
    }
  }

  if (hasSession && hasCodename && isSetupCodename) {
    return NextResponse.redirect(new URL('/dashboard', request.nextUrl));
  }

  // RBAC Admin Route Guarding
  if (request.nextUrl.pathname.startsWith('/admin')) {
    if (process.env.NEXT_PUBLIC_MOCK_AUTH === 'true') {
      const mockSession = request.cookies.get("mock-session")?.value;
      if (mockSession === "admin") {
        return NextResponse.next();
      }
    }
    const roles = (token?.user?.roles as string[]) || [];
    if (!token || !roles.includes("ADMIN")) {
      return NextResponse.redirect(new URL('/', request.nextUrl));
    }
  }

  return NextResponse.next();
});

export const config = {
  matcher: ['/((?!api|_next/static|_next/image|favicon.ico).*)'],
};
