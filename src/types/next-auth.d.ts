import NextAuth, { DefaultSession } from "next-auth"
declare module "next-auth" {
  interface Session {
    user: {
      id: string
      codename?: string | null
    } & DefaultSession["user"]
  }
  interface User {
    codename?: string | null
  }
}
