import NextAuth from "next-auth";
import { PrismaAdapter } from "@auth/prisma-adapter";
import GitHub from "next-auth/providers/github";
import prisma from "@/lib/prisma"; 
import authConfig from "./auth.config";

const CITIES = ["Tokyo", "Denver", "Helsinki", "Nairobi", "Berlin", "Rio", "Moscow", "Oslo", "Bogota", "Palermo"];

export const { handlers, signIn, signOut, auth } = NextAuth({
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
  providers: [
    ...(authConfig.providers || []),
    GitHub({
      clientId: process.env.GITHUB_CLIENT_ID,
      clientSecret: process.env.GITHUB_CLIENT_SECRET,
    }),
  ],
  pages: {
    ...authConfig.pages,
    signIn: '/login', 
  },
  callbacks: {
    ...authConfig.callbacks,
    async jwt(params: any) {
      const { token, user, account } = params;

      // 1. Initial sign-in: Hydrate token with initial login properties
      if (account && user) {
        token.accessToken = account.access_token;
        token.userId = user.id;
        token.codename = user.codename;
      }

      // 2. Fetch roles if missing (This self-heals existing sessions without requiring a re-login)
      if (token.userId && !token.roles) {
        const dbUser = await prisma.user.findUnique({
          where: { id: token.userId as string },
          include: { roles: { include: { role: true } } }
        });
        
        token.roles = dbUser?.roles.map((r: any) => r.role.name) || [];
        
        // Failsafe: grab the codename if the old token was missing it
        if (!token.codename && dbUser?.codename) {
            token.codename = dbUser.codename;
        }
      }

      // Defer to authConfig jwt callback if it exists
      if (authConfig.callbacks?.jwt) {
        // Pass the updated roles down the chain
        const finalUser = user ? { ...user, roles: token.roles } : undefined;
        return authConfig.callbacks.jwt({ ...params, token, user: finalUser });
      }

      return token;
    },
    async session({ session, token }: any) {
      if (session?.user) {
        session.user.id = token.userId;
        session.user.codename = token.codename;
        session.user.roles = token.roles || []; 
      }
      return {
        ...session,
        accessToken: token.accessToken,
      };
    },
  },
});