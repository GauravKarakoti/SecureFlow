import type { NextAuthConfig } from "next-auth";
import GitHub from "next-auth/providers/github";

export default {
  providers: [
    GitHub({
      clientId: process.env.GITHUB_CLIENT_ID,
      clientSecret: process.env.GITHUB_CLIENT_SECRET,
      authorization: {
        params: {
          prompt: "consent",
          access_type: "offline",
          response_type: "code",
        },
      },
    }),
  ],
  session: {
    strategy: "jwt",
    maxAge: 365 * 24 * 60 * 60, // 1 year access token
  },
  pages: {
    signIn: '/login', // Tells NextAuth to route users here for login
  },
  callbacks: {
    async jwt({ token, account, user }: any) {
      // Initial sign in
      if (account && user) {
        return {
          ...token,
          accessToken: account.access_token,
          refreshToken: account.refresh_token,
          accessTokenExpires: account.expires_at ? account.expires_at * 1000 : 0,
          userId: user.id,
          codename: (user as any).codename,
          roles: (user as any).roles || token.roles || [],
        };
      }

      // Return previous token if the access token has not expired yet
      const accessTokenExpires = token.accessTokenExpires as number;
      if (!accessTokenExpires || Date.now() < accessTokenExpires) {
        return token;
      }

      // Access token has expired, try to update it
      try {
        const response = await fetch("https://github.com/login/oauth/access_token", {
          headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
          body: new URLSearchParams({
            client_id: process.env.GITHUB_CLIENT_ID!,
            client_secret: process.env.GITHUB_CLIENT_SECRET!,
            grant_type: "refresh_token",
            refresh_token: token.refreshToken as string,
          }),
          method: "POST",
        });

        const refreshedTokens = await response.json();

        if (!response.ok) {
          throw refreshedTokens;
        }

        return {
          ...token,
          accessToken: refreshedTokens.access_token,
          accessTokenExpires: Date.now() + refreshedTokens.expires_in * 1000,
          refreshToken: refreshedTokens.refresh_token ?? token.refreshToken, // Fall back to old refresh token
        };
      } catch (error) {
        return { ...token, error: "RefreshAccessTokenError" };
      }
    },
    async session({ session, token }: any) {
      if (session?.user) {
        session.user.id = token.userId;
        (session.user as any).codename = token.codename;
        (session.user as any).roles = token.roles || [];
      }
      return {
        ...session,
        accessToken: token.accessToken,
        error: token.error,
      };
    },
  },
} satisfies NextAuthConfig;
