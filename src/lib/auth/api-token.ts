import crypto from "crypto";
import { NextRequest } from "next/server";
import prisma from "@/lib/prisma";
import { auth } from "@/auth";
import { getClientIp } from "@/lib/client-ip";

/**
 * Valid permission scopes for Personal API Tokens (#1867).
 */
export const API_TOKEN_SCOPES = [
  "findings:read",
  "findings:write",
  "scans:read",
  "scans:write",
  "policies:read",
  "policies:write",
  "audit:read",
] as const;

export type ApiTokenScope = (typeof API_TOKEN_SCOPES)[number];

export const TOKEN_PREFIX = "sft_";
export const TOKEN_PREFIX_DISPLAY_LENGTH = 12;

/**
 * Validate whether a string is a recognized ApiTokenScope.
 */
export function isValidScope(scope: string): scope is ApiTokenScope {
  return API_TOKEN_SCOPES.includes(scope as ApiTokenScope);
}

/**
 * Compute SHA-256 hash of a raw API token.
 */
export function hashApiToken(token: string): string {
  return crypto.createHash("sha256").update(token).digest("hex");
}

/**
 * Generate a new cryptographically secure Personal API Token.
 * Raw token format: `sft_<64_hex_chars>`.
 * Display prefix: `sft_<8_hex_chars>` (12 chars).
 * Database stores ONLY `tokenHash` (SHA-256) and `tokenPrefix`.
 */
export function generateApiToken(): {
  token: string;
  tokenPrefix: string;
  tokenHash: string;
} {
  const randomPart = crypto.randomBytes(32).toString("hex");
  const token = `${TOKEN_PREFIX}${randomPart}`;
  const tokenPrefix = token.slice(0, TOKEN_PREFIX_DISPLAY_LENGTH);
  const tokenHash = hashApiToken(token);
  return { token, tokenPrefix, tokenHash };
}

/**
 * Extract Bearer token from Request, NextRequest, or Headers.
 */
export function extractBearerToken(
  headersOrReq: Headers | Request | NextRequest | { headers: Headers },
): string | null {
  const headers = "headers" in headersOrReq ? headersOrReq.headers : headersOrReq;
  const authHeader = headers.get("authorization") || headers.get("Authorization");
  if (!authHeader) return null;
  const match = authHeader.match(/^Bearer\s+(.+)$/i);
  return match ? match[1].trim() : null;
}

export interface AuthenticatedApiToken {
  id: string;
  userId: string;
  name: string;
  tokenPrefix: string;
  scopes: string[];
  expiresAt: Date | null;
  revokedAt: Date | null;
  lastUsedAt: Date | null;
  lastUsedIp: string | null;
  createdAt: Date;
  user: {
    id: string;
    name: string | null;
    email: string | null;
  };
}

export type ApiTokenAuthResult =
  | {
      ok: true;
      token: AuthenticatedApiToken;
      userId: string;
      user: {
        id: string;
        name: string | null;
        email: string | null;
      };
    }
  | {
      ok: false;
      status: 401 | 403;
      error: "UNAUTHORIZED" | "TOKEN_EXPIRED" | "TOKEN_REVOKED" | "INSUFFICIENT_SCOPE";
      message: string;
    };

/**
 * Authenticate an incoming request via Personal API Token Bearer authorization.
 * Handles token lookup by hash, revocation check, expiration check, and scope verification.
 * Automatically updates `lastUsedAt` and `lastUsedIp` upon successful verification.
 */
export async function authenticateApiToken(
  req: NextRequest | Request | { headers: Headers },
  options?: {
    requiredScopes?: ApiTokenScope[];
    updateLastUsed?: boolean;
  },
): Promise<ApiTokenAuthResult> {
  const rawToken = extractBearerToken(req);
  if (!rawToken) {
    return {
      ok: false,
      status: 401,
      error: "UNAUTHORIZED",
      message: "Missing or invalid Authorization header",
    };
  }

  const tokenHash = hashApiToken(rawToken);

  const apiToken = await prisma.apiToken.findUnique({
    where: { tokenHash },
    include: {
      user: {
        select: {
          id: true,
          name: true,
          email: true,
        },
      },
    },
  });

  if (!apiToken) {
    return {
      ok: false,
      status: 401,
      error: "UNAUTHORIZED",
      message: "Invalid API token",
    };
  }

  if (apiToken.revokedAt !== null) {
    return {
      ok: false,
      status: 401,
      error: "TOKEN_REVOKED",
      message: "API token has been revoked",
    };
  }

  if (apiToken.expiresAt !== null && apiToken.expiresAt < new Date()) {
    return {
      ok: false,
      status: 401,
      error: "TOKEN_EXPIRED",
      message: "API token has expired",
    };
  }

  if (options?.requiredScopes && options.requiredScopes.length > 0) {
    const missing = options.requiredScopes.filter(
      (scope) => !apiToken.scopes.includes(scope),
    );
    if (missing.length > 0) {
      return {
        ok: false,
        status: 403,
        error: "INSUFFICIENT_SCOPE",
        message: `API token lacks required scope: ${missing.join(", ")}`,
      };
    }
  }

  if (options?.updateLastUsed !== false) {
    const clientIp = getClientIp(req.headers);
    const updatePromise = prisma.apiToken.update({
      where: { id: apiToken.id },
      data: {
        lastUsedAt: new Date(),
        lastUsedIp: clientIp !== "unknown" ? clientIp : null,
      },
    });
    if (updatePromise && typeof (updatePromise as any).catch === "function") {
      (updatePromise as any).catch((err: unknown) => {
        console.error("Failed to update API token last-used timestamp:", err);
      });
    }
  }

  return {
    ok: true,
    token: apiToken as AuthenticatedApiToken,
    userId: apiToken.userId,
    user: apiToken.user,
  };
}

export type AuthContextResult =
  | {
      ok: true;
      userId: string;
      authType: "session" | "token";
      token?: AuthenticatedApiToken;
      user?: {
        id: string;
        name?: string | null;
        email?: string | null;
      };
    }
  | {
      ok: false;
      status: 401 | 403;
      error: string;
      message: string;
    };

/**
 * Universal authentication helper for API routes.
 * Supports both Personal API Tokens (Authorization: Bearer <token>) and Browser Sessions (NextAuth).
 * If a Bearer token is provided, scope validation is strictly enforced.
 */
export async function authenticateUserOrToken(
  req: NextRequest,
  options?: {
    requiredScopes?: ApiTokenScope[];
    updateLastUsed?: boolean;
  },
): Promise<AuthContextResult> {
  const hasBearer = Boolean(extractBearerToken(req));

  if (hasBearer) {
    const tokenResult = await authenticateApiToken(req, options);
    if (!tokenResult.ok) {
      return tokenResult;
    }
    return {
      ok: true,
      userId: tokenResult.userId,
      authType: "token",
      token: tokenResult.token,
      user: tokenResult.user,
    };
  }

  // Fallback to NextAuth session
  const session = await auth();
  if (session?.user?.id) {
    return {
      ok: true,
      userId: session.user.id,
      authType: "session",
      user: session.user,
    };
  }

  return {
    ok: false,
    status: 401,
    error: "UNAUTHORIZED",
    message: "Unauthorized",
  };
}
