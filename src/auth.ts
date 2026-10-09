import NextAuth from "next-auth";
import { PrismaAdapter } from "@auth/prisma-adapter";
import prisma from "@/lib/prisma";
import authConfig from "./auth.config";
import { isMockAuthEnabled } from "@/lib/mock-auth";

const CITIES = [
  "Tokyo",
  "Denver",
  "Helsinki",
  "Nairobi",
  "Berlin",
  "Rio",
  "Moscow",
  "Oslo",
  "Bogota",
  "Palermo",
];

/**
 * How long roles copied into the JWT are trusted before they are re-read.
 *
 * Every admin check — the proxy guard, `/admin`'s layout, `requireAdmin` in the
 * admin server actions, `/api/admin/export` — reads `session.user.roles`, which
 * comes from the token. The token only re-read the database when its roles were
 * empty, its codename was missing or the client called `update()`, none of
 * which happens to an established admin. So demoting an admin (or deleting the
 * user) had no effect on their session, and sessions last a year. With this,
 * a change in the database reaches the session within the interval.
 */
export const ROLES_REFRESH_INTERVAL_MS = 5 * 60 * 1000;

const nextAuthResult = NextAuth({
  // Spread authConfig first to inherit providers, pages, and base session logic
  ...authConfig,
  adapter: {
    ...PrismaAdapter(prisma),
    createUser: async (user: any) => {
      return prisma.user.create({
        data: {
          id: user.id,
          name: user.name ?? null,
          email: user.email ?? null,
          emailVerified: user.emailVerified ?? null,
          image: user.image ?? null,
          githubLogin: user.githubLogin ?? null,
          codename: null,
          roles: {
            create: [
              {
                role: {
                  connectOrCreate: {
                    where: { name: "USER" },
                    create: { name: "USER", description: "Standard user access" },
                  },
                },
              },
            ],
          },
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
    async redirect({ url, baseUrl }: { url: string; baseUrl: string }) {
      if (url.startsWith("/")) return `${baseUrl}${url}`;

      try {
        const target = new URL(url);
        if (target.origin === new URL(baseUrl).origin) return url;
      } catch {}

      return `${baseUrl}/dashboard`;
    },
    async jwt(params: any) {
      const { token, user, account, trigger } = params;

      // 1. Initial sign-in: Hydrate token with initial login properties
      if (account && user) {
        token.accessToken = account.access_token;
        token.userId = user.id;
        token.codename = user.codename ?? null;
      }

      // 2. Fetch roles and codename if missing OR if a session update is triggered
      const userId = (token.userId || user?.id || token.sub) as string | undefined;
      const rolesStale =
        typeof token.rolesCheckedAt !== "number" ||
        Date.now() - token.rolesCheckedAt >= ROLES_REFRESH_INTERVAL_MS;
      if (
        userId &&
        (!token.roles ||
          token.roles.length === 0 ||
          !token.codename ||
          trigger === "update" ||
          rolesStale)
      ) {
        const dbUser = await prisma.user.findUnique({
          where: { id: userId },
          include: { roles: { include: { role: true } } },
        });

        token.roles = dbUser?.roles.map((r: any) => r.role.name) || [];
        token.rolesCheckedAt = Date.now();

        // Sync codename from database or session payload
        if (dbUser?.codename) {
          token.codename = dbUser.codename;
        } else if (params.session?.codename) {
          token.codename = params.session.codename;
        } else if (trigger === "update" && !dbUser?.codename) {
          token.codename = null;
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
  if (isMockAuthEnabled()) {
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
