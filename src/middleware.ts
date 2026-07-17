import NextAuth from "next-auth";
import authConfig from "./auth.config";
import { NextResponse } from "next/server";
import { ratelimit } from "@/lib/ratelimit";
import { getClientIp } from "@/lib/client-ip";

const { auth } = NextAuth(authConfig);

export default auth(async function middleware(request: any) {
  const token = request.auth;

  if (request.nextUrl.pathname.startsWith("/api/og") && ratelimit) {
    const ip = getClientIp(request.headers);
    const { success } = await ratelimit.limit(ip);

    if (!success) {
      return new NextResponse("Too Many Requests", { status: 429 });
    }
  }

  // RBAC Admin Route Guarding
  if (request.nextUrl.pathname.startsWith("/admin")) {
    // Depending on NextAuth/NextAuth(auth) integration, roles may be exposed either as:
    // - request.auth.user.roles
    // - request.auth.roles
    const rolesFromUser = (token?.user?.roles as string[] | undefined) ?? [];
    const rolesFromToken = (token?.roles as string[] | undefined) ?? [];
    const roles = rolesFromUser.length > 0 ? rolesFromUser : rolesFromToken;

    // Unauthenticated => redirect to dashboard
    if (!token) {
      return NextResponse.redirect(new URL("/dashboard", request.nextUrl));
    }

    // Authenticated but non-admin => 403
    if (!roles.includes("ADMIN")) {
      return new NextResponse("Forbidden", { status: 403 });
    }
  }

  return NextResponse.next();
});

export const config = {
  matcher: ["/((?!api|_next/static|_next/image|favicon.ico).*)"],
};
