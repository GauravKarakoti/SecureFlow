import NextAuth from "next-auth"
import { PrismaAdapter } from "@auth/prisma-adapter"
import prisma from "@/lib/prisma" 
import authConfig from "./auth.config"

const CITIES = ["Tokyo", "Denver", "Helsinki", "Nairobi", "Berlin", "Rio", "Moscow", "Oslo", "Bogota", "Palermo"];

export const { handlers, signIn, signOut, auth } = NextAuth({
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
  ...authConfig,
  callbacks: {
    ...authConfig.callbacks,
    async jwt(params: any) {
      const { token, user, account } = params;
      let finalUser = user;

      if (account && user) {
        const dbUser = await prisma.user.findUnique({
          where: { id: user.id },
          include: { roles: { include: { role: true } } }
        });
        const roles = dbUser?.roles.map((r: any) => r.role.name) || [];
        
        finalUser = { ...user, roles };
      }

      if (authConfig.callbacks?.jwt) {
        return authConfig.callbacks.jwt({ ...params, user: finalUser });
      }

      return token;
    }
  }
})