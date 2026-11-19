import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  generateApiToken,
  hashApiToken,
  extractBearerToken,
  authenticateApiToken,
  authenticateUserOrToken,
  API_TOKEN_SCOPES,
  isValidScope,
} from "./api-token";
import prisma from "@/lib/prisma";
import { auth } from "@/auth";

vi.mock("@/lib/prisma", () => ({
  default: {
    apiToken: {
      findUnique: vi.fn(),
      update: vi.fn(),
    },
  },
}));

vi.mock("@/auth", () => ({
  auth: vi.fn(),
}));

vi.mock("@/lib/client-ip", () => ({
  getClientIp: vi.fn(() => "198.51.100.42"),
}));

describe("api-token utils", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("generateApiToken & hashApiToken", () => {
    it("generates a token with sft_ prefix, 68 chars total, and valid prefix/hash", () => {
      const { token, tokenPrefix, tokenHash } = generateApiToken();
      expect(token).toMatch(/^sft_[0-9a-f]{64}$/);
      expect(tokenPrefix).toBe(token.slice(0, 12));
      expect(tokenHash).toBe(hashApiToken(token));
      expect(tokenHash).toHaveLength(64);
    });

    it("hashes deterministically", () => {
      const token = "sft_1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef";
      const hash1 = hashApiToken(token);
      const hash2 = hashApiToken(token);
      expect(hash1).toBe(hash2);
    });

    it("validates scopes correctly", () => {
      expect(isValidScope("findings:read")).toBe(true);
      expect(isValidScope("scans:write")).toBe(true);
      expect(isValidScope("policies:write")).toBe(true);
      expect(isValidScope("invalid:scope")).toBe(false);
      expect(API_TOKEN_SCOPES).toContain("audit:read");
    });
  });

  describe("extractBearerToken", () => {
    it("extracts token from standard Authorization: Bearer header", () => {
      const headers = new Headers();
      headers.set("Authorization", "Bearer sft_secret123");
      expect(extractBearerToken(headers)).toBe("sft_secret123");
    });

    it("handles lowercase bearer scheme", () => {
      const headers = new Headers();
      headers.set("authorization", "bearer sft_secret456");
      expect(extractBearerToken(headers)).toBe("sft_secret456");
    });

    it("returns null when header is missing or non-bearer", () => {
      expect(extractBearerToken(new Headers())).toBeNull();
      const headers = new Headers();
      headers.set("Authorization", "Basic user:pass");
      expect(extractBearerToken(headers)).toBeNull();
    });
  });

  describe("authenticateApiToken", () => {
    const rawToken = "sft_0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
    const tokenHash = hashApiToken(rawToken);

    function makeRequest(tokenHeader?: string) {
      const headers = new Headers();
      if (tokenHeader !== undefined) {
        headers.set("Authorization", tokenHeader);
      }
      return { headers };
    }

    it("returns 401 when Authorization header is missing", async () => {
      const res = await authenticateApiToken(makeRequest());
      expect(res.ok).toBe(false);
      if (!res.ok) {
        expect(res.status).toBe(401);
        expect(res.error).toBe("UNAUTHORIZED");
      }
    });

    it("returns 401 when token is not found in database", async () => {
      vi.mocked(prisma.apiToken.findUnique).mockResolvedValueOnce(null);

      const res = await authenticateApiToken(makeRequest(`Bearer ${rawToken}`));
      expect(res.ok).toBe(false);
      if (!res.ok) {
        expect(res.status).toBe(401);
        expect(res.error).toBe("UNAUTHORIZED");
        expect(res.message).toBe("Invalid API token");
      }
      expect(prisma.apiToken.findUnique).toHaveBeenCalledWith({
        where: { tokenHash },
        include: {
          user: {
            select: { id: true, name: true, email: true },
          },
        },
      });
    });

    it("returns 401 when token has been revoked", async () => {
      vi.mocked(prisma.apiToken.findUnique).mockResolvedValueOnce({
        id: "tok_1",
        userId: "user_1",
        name: "CI Token",
        tokenHash,
        tokenPrefix: "sft_01234567",
        scopes: ["scans:write"],
        expiresAt: null,
        revokedAt: new Date(Date.now() - 60000),
        lastUsedAt: null,
        lastUsedIp: null,
        createdAt: new Date(),
        updatedAt: new Date(),
        user: { id: "user_1", name: "Alice", email: "alice@example.com" },
      } as any);

      const res = await authenticateApiToken(makeRequest(`Bearer ${rawToken}`));
      expect(res.ok).toBe(false);
      if (!res.ok) {
        expect(res.status).toBe(401);
        expect(res.error).toBe("TOKEN_REVOKED");
        expect(res.message).toContain("revoked");
      }
    });

    it("returns 401 when token has expired", async () => {
      vi.mocked(prisma.apiToken.findUnique).mockResolvedValueOnce({
        id: "tok_2",
        userId: "user_1",
        name: "Old Token",
        tokenHash,
        tokenPrefix: "sft_01234567",
        scopes: ["findings:read"],
        expiresAt: new Date(Date.now() - 10000), // expired 10s ago
        revokedAt: null,
        lastUsedAt: null,
        lastUsedIp: null,
        createdAt: new Date(),
        updatedAt: new Date(),
        user: { id: "user_1", name: "Alice", email: "alice@example.com" },
      } as any);

      const res = await authenticateApiToken(makeRequest(`Bearer ${rawToken}`));
      expect(res.ok).toBe(false);
      if (!res.ok) {
        expect(res.status).toBe(401);
        expect(res.error).toBe("TOKEN_EXPIRED");
        expect(res.message).toContain("expired");
      }
    });

    it("returns 403 when token lacks required scopes", async () => {
      vi.mocked(prisma.apiToken.findUnique).mockResolvedValueOnce({
        id: "tok_3",
        userId: "user_1",
        name: "Read-only Token",
        tokenHash,
        tokenPrefix: "sft_01234567",
        scopes: ["findings:read"],
        expiresAt: new Date(Date.now() + 86400000),
        revokedAt: null,
        lastUsedAt: null,
        lastUsedIp: null,
        createdAt: new Date(),
        updatedAt: new Date(),
        user: { id: "user_1", name: "Alice", email: "alice@example.com" },
      } as any);

      const res = await authenticateApiToken(makeRequest(`Bearer ${rawToken}`), {
        requiredScopes: ["findings:read", "scans:write"],
      });
      expect(res.ok).toBe(false);
      if (!res.ok) {
        expect(res.status).toBe(403);
        expect(res.error).toBe("INSUFFICIENT_SCOPE");
        expect(res.message).toContain("scans:write");
      }
    });

    it("returns 200/ok: true and updates lastUsedAt when valid", async () => {
      vi.mocked(prisma.apiToken.findUnique).mockResolvedValueOnce({
        id: "tok_4",
        userId: "user_1",
        name: "Full Token",
        tokenHash,
        tokenPrefix: "sft_01234567",
        scopes: ["findings:read", "findings:write", "scans:read"],
        expiresAt: new Date(Date.now() + 86400000),
        revokedAt: null,
        lastUsedAt: null,
        lastUsedIp: null,
        createdAt: new Date(),
        updatedAt: new Date(),
        user: { id: "user_1", name: "Alice", email: "alice@example.com" },
      } as any);

      vi.mocked(prisma.apiToken.update).mockResolvedValueOnce({} as any);

      const res = await authenticateApiToken(makeRequest(`Bearer ${rawToken}`), {
        requiredScopes: ["findings:read"],
      });

      expect(res.ok).toBe(true);
      if (res.ok) {
        expect(res.userId).toBe("user_1");
        expect(res.token.name).toBe("Full Token");
        expect(res.user.email).toBe("alice@example.com");
      }
      expect(prisma.apiToken.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: "tok_4" },
          data: expect.objectContaining({
            lastUsedIp: "198.51.100.42",
          }),
        }),
      );
    });
  });

  describe("authenticateUserOrToken", () => {
    it("authenticates via Bearer token when present", async () => {
      const rawToken = "sft_abc1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef";
      const tokenHash = hashApiToken(rawToken);

      vi.mocked(prisma.apiToken.findUnique).mockResolvedValueOnce({
        id: "tok_5",
        userId: "user_token",
        name: "Token User",
        tokenHash,
        tokenPrefix: "sft_abc12345",
        scopes: ["scans:write"],
        expiresAt: null,
        revokedAt: null,
        lastUsedAt: null,
        lastUsedIp: null,
        createdAt: new Date(),
        updatedAt: new Date(),
        user: { id: "user_token", name: "Bob", email: "bob@example.com" },
      } as any);

      const req = {
        headers: new Headers({ Authorization: `Bearer ${rawToken}` }),
      } as any;

      const res = await authenticateUserOrToken(req, { requiredScopes: ["scans:write"] });
      expect(res.ok).toBe(true);
      if (res.ok) {
        expect(res.authType).toBe("token");
        expect(res.userId).toBe("user_token");
      }
      expect(auth).not.toHaveBeenCalled();
    });

    it("falls back to session when no Bearer header is provided", async () => {
      vi.mocked(auth).mockResolvedValueOnce({
        user: { id: "user_session", name: "Session User" },
      } as any);

      const req = {
        headers: new Headers(),
      } as any;

      const res = await authenticateUserOrToken(req);
      expect(res.ok).toBe(true);
      if (res.ok) {
        expect(res.authType).toBe("session");
        expect(res.userId).toBe("user_session");
      }
    });

    it("returns 401 when neither token nor session is present", async () => {
      vi.mocked(auth).mockResolvedValueOnce(null as any);

      const req = {
        headers: new Headers(),
      } as any;

      const res = await authenticateUserOrToken(req);
      expect(res.ok).toBe(false);
      if (!res.ok) {
        expect(res.status).toBe(401);
      }
    });
  });
});
