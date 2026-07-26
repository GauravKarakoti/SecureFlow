import NextAuth from "next-auth";
import { PrismaAdapter } from "@auth/prisma-adapter";
import prisma from "@/lib/prisma"; 
import authConfig from "./auth.config";
import { withRateLimit } from "@/lib/middleware/rateLimit";

const CITIES = ["Tokyo", "Denver", "Helsinki", "Nairobi", "Berlin", "Rio", "Moscow", "Oslo", "Bogota", "Palermo"];

const nextAuthResult = NextAuth({
  // Spread authConfig first to inherit providers, pages, and base session logic
  ...authConfig,
  adapter: {
    ...PrismaAdapter(prisma),
    createUser: async (user: any) => {
      const codename = CITIES[Math.floor(Math.random() * CITIES.length)];
      return prisma.user.create({
        data: {
          ...user,
          codename,
          roles: {
            create: [{
              role: { connectOrCreate: { where: { name: "USER" }, create: { name: "USER", description: "Standard user access" } } }
            }]
          }
        },
      }) as any;
    },
  },
  session: {
    ...authConfig.session,
    strategy: "jwt",
    maxAge: 365 * 24 * 60 * 60, // 1 Year
  },
  callbacks: {
    ...authConfig.callbacks,
    async jwt(params: any) {
      const { token, user, account, trigger } = params;

      // 1. Initial sign-in: Hydrate token with initial login properties
      if (account && user) {
        token.accessToken = account.access_token;
        token.userId = user.id;
        token.codename = user.codename;
      }

      // 2. Fetch roles if missing OR if a session update is triggered
      const userId = (token.userId || user?.id || token.sub) as string | undefined;
      if ((userId && (!token.roles || token.roles.length === 0)) || trigger === "update") {
        const dbUser = await prisma.user.findUnique({
          where: { id: userId },
          include: { roles: { include: { role: true } } }
        });
        
        token.roles = dbUser?.roles.map((r: any) => r.role.name) || [];
        
        // Failsafe: grab the codename if the old token was missing it
        if (!token.codename && dbUser?.codename) {
          token.codename = dbUser.codename;
        }
      }

      // Defer to authConfig jwt callback to handle the GitHub access token refresh
      if (authConfig.callbacks?.jwt) {
        // Pass the updated roles down the chain
        const finalUser = user ? { ...user, roles: token.roles } : undefined;
        return authConfig.callbacks.jwt({ ...params, token, user: finalUser });
      }

      return token;
    },
  },
});

export const handlers = nextAuthResult.handlers;
export const signIn = nextAuthResult.signIn;
export const signOut = nextAuthResult.signOut;
export const auth = async (...args: any[]) => {
  if (process.env.NEXT_PUBLIC_MOCK_AUTH === "true") {
    let mockSessionCookie: string | undefined;
    try {
      const { cookies } = await import("next/headers");
      const cookieStore = await cookies();
      mockSessionCookie = cookieStore.get("mock-session")?.value;
    } catch (e) {
      // Ignore if called outside of request context (like early static build phase)
    }

    if (mockSessionCookie === "admin") {
      return {
        user: {
          id: "mock-admin-id",
          name: "Mock Admin",
          email: "admin@secureflow.test",
          roles: ["ADMIN", "USER"],
          codename: "Professor",
        },
        expires: new Date(Date.now() + 3600 * 1000).toISOString(),
      } as any;
    } else if (mockSessionCookie === "user") {
      return {
        user: {
          id: "mock-user-id",
          name: "Mock User",
          email: "user@secureflow.test",
          roles: ["USER"],
          codename: "Rio",
        },
        expires: new Date(Date.now() + 3600 * 1000).toISOString(),
      } as any;
    } else if (mockSessionCookie === "none") {
      return null;
    }
  }
  return (nextAuthResult.auth as any)(...args);
};