import NextAuth from "next-auth";
import { PrismaAdapter } from "@auth/prisma-adapter";
import GitHub from "next-auth/providers/github";
import prisma from "@/lib/prisma"; 
import authConfig from "./auth.config";

const CITIES = ["Tokyo", "Denver", "Helsinki", "Nairobi", "Berlin", "Rio", "Moscow", "Oslo", "Bogota", "Palermo"];

export const { handlers, signIn, signOut, auth } = NextAuth({
  // 1. Spread base config first so explicit properties below override it safely
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
    ...authConfig.session, // Preserve any session settings from authConfig
    strategy: "jwt",
    maxAge: 365 * 24 * 60 * 60, // 1 Year
  },
  providers: [
    ...(authConfig.providers || []), // Combine providers from both files
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
      let finalUser = user;

      if (account && user) {
        // Hydrate token with initial login properties
        token.accessToken = account.access_token;
        token.userId = user.id;
        token.codename = user.codename;

        const dbUser = await prisma.user.findUnique({
          where: { id: user.id },
          include: { roles: { include: { role: true } } }
        });
        
        const roles = dbUser?.roles.map((r: any) => r.role.name) || [];
        
        // 1. ATTACH ROLES TO THE TOKEN HERE
        token.roles = roles; 
        
        finalUser = { ...user, roles };
      }

      // Defer to authConfig jwt callback if it exists
      if (authConfig.callbacks?.jwt) {
        return authConfig.callbacks.jwt({ ...params, token, user: finalUser });
      }

      return token;
    },
    async session({ session, token }: any) {
      if (session?.user) {
        session.user.id = token.userId;
        session.user.codename = token.codename;
        
        // 2. PASS ROLES FROM TOKEN TO SESSION HERE
        session.user.roles = token.roles; 
      }
      return {
        ...session,
        // GitHub OAuth App tokens don't expire, so this is just the
        // original access token — safe for server components to use
        // to call the GitHub API on the user's behalf. Read server-side only.
        accessToken: token.accessToken,
      };
    },
  },
});