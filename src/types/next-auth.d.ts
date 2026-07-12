import NextAuth, { DefaultSession } from "next-auth"
import { JWT } from "next-auth/jwt"

declare module "next-auth" {
  interface Session {
    user: {
      id: string
      codename?: string | null
      roles?: string[]
    } & DefaultSession["user"]
  }
  interface User {
    codename?: string | null
    roles?: string[]
  }
}

declare module "next-auth/jwt" {
  interface JWT {
    userId?: string
    codename?: string | null
    roles?: string[]
    error?: string
  }
}
