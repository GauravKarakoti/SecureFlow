import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";
import {
  generateApiToken,
  hashApiToken,
  authenticateUserOrToken,
  authenticateApiToken,
} from "@/lib/auth/api-token";
import prisma from "@/lib/prisma";

vi.mock("@/lib/prisma", () => ({
  default: {
    apiToken: {
      findUnique: vi.fn(),
      update: vi.fn(),
      findFirst: vi.fn(),
      create: vi.fn(),
    },
    auditLog: {
      create: vi.fn(),
    },
  },
}));

vi.mock("@/auth", () => ({
  auth: vi.fn(),
}));

vi.mock("@/lib/client-ip", () => ({
  getClientIp: () => "192.0.2.100",
}));

describe("Personal API Tokens Acceptance Criteria (#1867)", () => {
  const rawToken = "sft_e2e_112233445566778899aabbccddeeff00112233445566778899aabbccddeeff";
  const tokenHash = hashApiToken(rawToken);

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("Acceptance Criterion 1: Tokens work for allowed scopes and get 403 for others", async () => {
    // Token has only findings:read
    vi.mocked(prisma.apiToken.findUnique).mockResolvedValue({
      id: "tok-read-only",
      userId: "user-alice",
      name: "Triage Reader",
      tokenHash,
      tokenPrefix: "sft_e2e_1122",
      scopes: ["findings:read"],
      expiresAt: new Date(Date.now() + 86400000),
      revokedAt: null,
      lastUsedAt: null,
      lastUsedIp: null,
      createdAt: new Date(),
      updatedAt: new Date(),
      user: { id: "user-alice", name: "Alice", email: "alice@test.local" },
    } as any);

    // Request with findings:read scope -> allowed
    const reqAllowed = new NextRequest("http://localhost/api/findings", {
      headers: { Authorization: `Bearer ${rawToken}` },
    });
    const resAllowed = await authenticateUserOrToken(reqAllowed, {
      requiredScopes: ["findings:read"],
    });
    expect(resAllowed.ok).toBe(true);
    if (resAllowed.ok) {
      expect(resAllowed.userId).toBe("user-alice");
      expect(resAllowed.authType).toBe("token");
    }

    // Request with scans:write scope -> 403 Forbidden
    const reqDenied = new NextRequest("http://localhost/api/findings", {
      headers: { Authorization: `Bearer ${rawToken}` },
    });
    const resDenied = await authenticateUserOrToken(reqDenied, {
      requiredScopes: ["scans:write"],
    });
    expect(resDenied.ok).toBe(false);
    if (!resDenied.ok) {
      expect(resDenied.status).toBe(403);
      expect(resDenied.error).toBe("INSUFFICIENT_SCOPE");
      expect(resDenied.message).toContain("scans:write");
    }
  });

  it("Acceptance Criterion 2: Expired and revoked tokens get 401", async () => {
    // 2a. Revoked token
    vi.mocked(prisma.apiToken.findUnique).mockResolvedValueOnce({
      id: "tok-revoked",
      userId: "user-bob",
      name: "Old CI",
      tokenHash,
      tokenPrefix: "sft_e2e_1122",
      scopes: ["scans:write"],
      expiresAt: new Date(Date.now() + 86400000),
      revokedAt: new Date(Date.now() - 3600000), // revoked 1h ago
      lastUsedAt: null,
      lastUsedIp: null,
      createdAt: new Date(),
      updatedAt: new Date(),
      user: { id: "user-bob", name: "Bob", email: "bob@test.local" },
    } as any);

    const reqRevoked = new NextRequest("http://localhost/api/cli/scan", {
      headers: { Authorization: `Bearer ${rawToken}` },
    });
    const resRevoked = await authenticateUserOrToken(reqRevoked, {
      requiredScopes: ["scans:write"],
    });
    expect(resRevoked.ok).toBe(false);
    if (!resRevoked.ok) {
      expect(resRevoked.status).toBe(401);
      expect(resRevoked.error).toBe("TOKEN_REVOKED");
    }

    // 2b. Expired token
    vi.mocked(prisma.apiToken.findUnique).mockResolvedValueOnce({
      id: "tok-expired",
      userId: "user-bob",
      name: "Past Expiry",
      tokenHash,
      tokenPrefix: "sft_e2e_1122",
      scopes: ["scans:write"],
      expiresAt: new Date(Date.now() - 60000), // expired 1m ago
      revokedAt: null,
      lastUsedAt: null,
      lastUsedIp: null,
      createdAt: new Date(),
      updatedAt: new Date(),
      user: { id: "user-bob", name: "Bob", email: "bob@test.local" },
    } as any);

    const reqExpired = new NextRequest("http://localhost/api/cli/scan", {
      headers: { Authorization: `Bearer ${rawToken}` },
    });
    const resExpired = await authenticateUserOrToken(reqExpired, {
      requiredScopes: ["scans:write"],
    });
    expect(resExpired.ok).toBe(false);
    if (!resExpired.ok) {
      expect(resExpired.status).toBe(401);
      expect(resExpired.error).toBe("TOKEN_EXPIRED");
    }
  });

  it("Acceptance Criterion 3: Only the hash is stored in the database", () => {
    const { token, tokenPrefix, tokenHash } = generateApiToken();
    expect(token).toMatch(/^sft_[0-9a-f]{64}$/);
    expect(tokenPrefix).toBe(token.slice(0, 12));
    expect(tokenHash).toHaveLength(64);
    // Ensure the raw token string is not contained within the hash
    expect(tokenHash).not.toContain(token);
    expect(tokenHash).toBe(hashApiToken(token));
  });

  it("Acceptance Criterion 4: Records lastUsedAt and lastUsedIp upon successful authentication", async () => {
    vi.mocked(prisma.apiToken.findUnique).mockResolvedValueOnce({
      id: "tok-used",
      userId: "user-alice",
      name: "CLI Token",
      tokenHash,
      tokenPrefix: "sft_e2e_1122",
      scopes: ["scans:write"],
      expiresAt: null,
      revokedAt: null,
      lastUsedAt: null,
      lastUsedIp: null,
      createdAt: new Date(),
      updatedAt: new Date(),
      user: { id: "user-alice", name: "Alice", email: "alice@test.local" },
    } as any);

    const updatePromise = Promise.resolve({});
    vi.mocked(prisma.apiToken.update).mockReturnValue(updatePromise as any);

    const req = new NextRequest("http://localhost/api/cli/scan", {
      headers: { Authorization: `Bearer ${rawToken}` },
    });

    const res = await authenticateApiToken(req);
    expect(res.ok).toBe(true);

    expect(prisma.apiToken.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "tok-used" },
        data: expect.objectContaining({
          lastUsedIp: "192.0.2.100",
          lastUsedAt: expect.any(Date),
        }),
      }),
    );
  });
});
