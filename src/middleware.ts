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
  
  // RBAC Admin Route Guarding (/admin/*)
  if (request.nextUrl.pathname.startsWith('/admin')) {
    if (process.env.NEXT_PUBLIC_MOCK_AUTH === 'true') {
      const mockSession = request.cookies.get('mock-session')?.value;
      if (mockSession === 'admin') {
        return NextResponse.next();
      }
      if (mockSession === 'user') {
        return NextResponse.redirect(new URL('/dashboard', request.nextUrl));
      }
      return NextResponse.redirect(new URL('/login', request.nextUrl));
    }

    const roles: string[] =
      (token?.user?.roles as string[]) || (token?.roles as string[]) || [];

    if (!token) {
      return NextResponse.redirect(new URL('/login', request.nextUrl));
    }

    if (!roles.includes('ADMIN')) {
      return NextResponse.redirect(new URL('/dashboard', request.nextUrl));
    }
  }

  return NextResponse.next();
});

export const config = {
  matcher: ['/((?!api|_next/static|_next/image|favicon.ico).*)'],
};
