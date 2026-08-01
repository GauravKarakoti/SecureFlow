
import NextAuth from "next-auth"
import GitHub from "next-auth/providers/github"
import { PrismaAdapter } from "@auth/prisma-adapter"
import prisma from "@/lib/prisma"
import NextAuth from "next-auth";
import { PrismaAdapter } from "@auth/prisma-adapter";
import prisma from "@/lib/prisma"; 
import authConfig from "./auth.config";
main

const CITIES = ["Tokyo", "Denver", "Helsinki", "Nairobi", "Berlin", "Rio", "Moscow", "Oslo", "Bogota", "Palermo"];

const nextAuthResult = NextAuth({
  // Spread authConfig first to inherit providers, pages, and base session logic
  ...authConfig,
  adapter: {
    ...PrismaAdapter(prisma),
fix/leaderboard-codename-420
    createUser: async (user) => {
      const existingUser = user.email
        ? await prisma.user.findUnique({
            where: { email: user.email },
            select: { codename: true },
          })
        : null;

      const codename = existingUser?.codename || CITIES[Math.floor(Math.random() * CITIES.length)];

      const createdUser = await prisma.user.create({

    createUser: async (user: any) => {
      const codename = CITIES[Math.floor(Math.random() * CITIES.length)];
      const githubLogin = user.githubLogin ?? null;
      const { githubLogin: _drop, ...rest } = user;
      return prisma.user.create({
main
        data: {
          ...rest,
          githubLogin,
          codename,
          roles: {
            create: [{
              role: { connectOrCreate: { where: { name: "USER" }, create: { name: "USER", description: "Standard user access" } } }
            }]
          }
        },
      });

      return createdUser as typeof createdUser & {
        email: string;
        emailVerified: Date | null;
      };
    },
  },
  session: {
    ...authConfig.session,
    strategy: "jwt",
    maxAge: 365 * 24 * 60 * 60, // 1 Year
  },
  callbacks: {
    async jwt({ token, account, user }) {
      // Initial sign in
      if (account && user) {
        const dbUser = user.id
          ? await prisma.user.findUnique({
              where: { id: user.id },
              select: { codename: true },
            })
          : null;

        const fallbackCodename = (user as { codename?: string }).codename;

        return {
          ...token,
          accessToken: account.access_token,
          refreshToken: account.refresh_token,
          accessTokenExpires: account.expires_at ? account.expires_at * 1000 : 0,
          userId: user.id,
          codename: dbUser?.codename || fallbackCodename,
        };
      }

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
    },
    async session({ session, token }) {
      if (session?.user) {
        Object.assign(session.user, {
          id: token.userId as string,
          codename: token.codename as string,
        });
      }

      return token;
    },
  },
})
