import NextAuth, { DefaultSession } from "next-auth"
declare module "next-auth" {
  interface Session {
    user: {
      id: string
      codename?: string | null
    } & DefaultSession["user"]
    /** GitHub OAuth access token, refreshed on read. Server-side use only. */
    accessToken?: string | null
    /** Set to "RefreshAccessTokenError" when the token refresh failed. */
    error?: string | null
  }
  interface User {
    codename?: string | null
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
