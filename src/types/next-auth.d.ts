import NextAuth, { DefaultSession } from "next-auth"
import { JWT } from "next-auth/jwt"

declare module "next-auth" {
  interface Session {
    user: {
      id: string
      codename?: string | null
      roles?: string[]
    } & DefaultSession["user"]
    /** GitHub OAuth access token, refreshed on read. Server-side use only. */
    accessToken?: string | null
    /** Set to "RefreshAccessTokenError" when the token refresh failed. */
    error?: string | null
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

declare module "next-auth/jwt" {
  interface JWT {
    accessToken?: string | null
    refreshToken?: string | null
    accessTokenExpires?: number
    userId?: string
    codename?: string | null
    error?: string | null
  }
}
