import { NextResponse } from "next/server";
import NextAuth from "next-auth";
import authConfig from "./auth.config";
import { ratelimit } from "@/lib/ratelimit";

const { auth } = NextAuth(authConfig);

export default auth(async (req: any) => {
  const { nextUrl } = req;
  const token = req.auth;

  // Rate Limiting Logic for /api/og
  if (nextUrl.pathname.startsWith('/api/og') && ratelimit) {
    const ip = req.headers.get('x-forwarded-for') ?? '127.0.0.1';
    const { success } = await ratelimit.limit(ip);
    
    if (!success) {
      return new NextResponse('Too Many Requests', { status: 429 });
    }
  }
  
  // RBAC Admin Route Guarding
  if (nextUrl.pathname.startsWith('/admin')) {
    const roles = (token?.user?.roles as string[]) || [];
    if (!token || !roles.includes("ADMIN")) {
      return NextResponse.redirect(new URL('/', nextUrl));
    }
  }

  return NextResponse.next();
});

export const config = {
  matcher: ['/((?!api|_next/static|_next/image|favicon.ico).*)'],
};
