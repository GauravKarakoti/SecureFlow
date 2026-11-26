import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * Server actions behind /dashboard/settings: saving and reading the user's
 * Slack webhook URL.
 */

let session: { user: { id?: string } } | null = { user: { id: "user-1" } };

vi.mock("@/auth", () => ({
  auth: vi.fn(async () => session),
}));

const mockUpdate = vi.hoisted(() => vi.fn());
const mockFindUnique = vi.hoisted(() => vi.fn());
const mockRepoFindMany = vi.hoisted(() => vi.fn());
const mockRepoFindFirst = vi.hoisted(() => vi.fn());
const mockRepoUpdate = vi.hoisted(() => vi.fn());
const mockOutboundWebhookFindMany = vi.hoisted(() => vi.fn());
const mockOutboundWebhookFindFirst = vi.hoisted(() => vi.fn());
const mockOutboundWebhookCreate = vi.hoisted(() => vi.fn());
const mockOutboundWebhookUpdate = vi.hoisted(() => vi.fn());
const mockOutboundWebhookDelete = vi.hoisted(() => vi.fn());
const mockOutboundDeliveryFindMany = vi.hoisted(() => vi.fn());
const mockRevalidatePath = vi.hoisted(() => vi.fn());
const mockApiTokenFindMany = vi.hoisted(() => vi.fn());
const mockApiTokenCreate = vi.hoisted(() => vi.fn());
const mockApiTokenFindFirst = vi.hoisted(() => vi.fn());
const mockApiTokenUpdate = vi.hoisted(() => vi.fn());
const mockAuditLogCreate = vi.hoisted(() => vi.fn());

vi.mock("@/lib/prisma", () => ({
  default: {
    user: {
      update: mockUpdate,
      findUnique: mockFindUnique,
    },
    repository: {
      findMany: mockRepoFindMany,
      findFirst: mockRepoFindFirst,
      update: mockRepoUpdate,
    },
    apiToken: {
      findMany: mockApiTokenFindMany,
      create: mockApiTokenCreate,
      findFirst: mockApiTokenFindFirst,
      update: mockApiTokenUpdate,
    },
    auditLog: {
      create: mockAuditLogCreate,
    },
    outboundWebhook: {
      findMany: mockOutboundWebhookFindMany,
      findFirst: mockOutboundWebhookFindFirst,
      create: mockOutboundWebhookCreate,
      update: mockOutboundWebhookUpdate,
      delete: mockOutboundWebhookDelete,
    },
    outboundWebhookDelivery: {
      findMany: mockOutboundDeliveryFindMany,
    },
    installationSettings: {
      findUnique: vi.fn().mockResolvedValue(null),
    },
  },
}));

vi.mock("next/cache", () => ({
  revalidatePath: mockRevalidatePath,
}));

import {
  getSlackWebhook,
  updateSlackWebhook,
  getUserRepositoriesWithBadgeStatus,
  updateRepositoryPublicBadge,
  getApiTokens,
  createApiToken,
  revokeApiToken,
  getOutboundWebhooks,
  createOutboundWebhook,
  deleteOutboundWebhook,
  toggleOutboundWebhook,
  getOutboundWebhookDeliveries,
  updateRepositoryCodeScanning,
} from "./settings";

const WEBHOOK = "https://hooks.slack.com/services/T000/B000/XXXX";

beforeEach(() => {
  vi.clearAllMocks();
  session = { user: { id: "user-1" } };
  mockUpdate.mockResolvedValue({});
  mockFindUnique.mockResolvedValue(null);
});

describe("updateSlackWebhook", () => {
  it("rejects callers without a session", async () => {
    session = null;
    await expect(updateSlackWebhook(WEBHOOK)).rejects.toThrow("Unauthorized");
    expect(mockUpdate).not.toHaveBeenCalled();
  });

  it("rejects a session that has no user id", async () => {
    session = { user: {} };
    await expect(updateSlackWebhook(WEBHOOK)).rejects.toThrow("Unauthorized");
    expect(mockUpdate).not.toHaveBeenCalled();
  });

  it("rejects a value that is not a URL without writing anything", async () => {
    await expect(updateSlackWebhook("not a url")).rejects.toThrow(
      "Invalid Slack webhook URL format.",
    );
    expect(mockUpdate).not.toHaveBeenCalled();
    expect(mockRevalidatePath).not.toHaveBeenCalled();
  });

  it("stores the trimmed URL for the signed-in user and revalidates the page", async () => {
    await expect(updateSlackWebhook(`  ${WEBHOOK}  `)).resolves.toEqual({ success: true });

    expect(mockUpdate).toHaveBeenCalledWith({
      where: { id: "user-1" },
      data: { slackWebhookUrl: WEBHOOK },
    });
    expect(mockRevalidatePath).toHaveBeenCalledWith("/dashboard/settings");
  });

  describe("SSRF security policy enforcement", () => {
    it.each([
      ["http scheme", "http://hooks.slack.com/services/T000/B000/XXXX"],
      ["ftp scheme", "ftp://hooks.slack.com/services/T000/B000/XXXX"],
      ["gopher scheme", "gopher://hooks.slack.com/services/T000/B000/XXXX"],
    ])("rejects invalid scheme: %s", async (_label, url) => {
      await expect(updateSlackWebhook(url)).rejects.toThrow();
      expect(mockUpdate).not.toHaveBeenCalled();
      expect(mockRevalidatePath).not.toHaveBeenCalled();
    });

    it.each([
      ["IPv4 loopback http", "http://127.0.0.1/"],
      ["IPv4 loopback https", "https://127.0.0.1/"],
      ["localhost http", "http://localhost/"],
      ["localhost https", "https://localhost/"],
      ["private 10.0.0.0/8", "https://10.0.0.1/"],
      ["private 172.16.0.0/12", "https://172.16.0.1/"],
      ["private 192.168.0.0/16", "https://192.168.1.1/"],
      ["cloud metadata 169.254.169.254", "https://169.254.169.254/"],
      ["IPv6 loopback", "https://[::1]/"],
      ["IPv6 link-local", "https://[fe80::1]/"],
    ])("rejects internal destination: %s", async (_label, url) => {
      await expect(updateSlackWebhook(url)).rejects.toThrow();
      expect(mockUpdate).not.toHaveBeenCalled();
      expect(mockRevalidatePath).not.toHaveBeenCalled();
    });

    it.each([
      ["arbitrary domain", "https://evil.example.com/services/T000/B000/XXXX"],
      ["subdomain suffix attack", "https://hooks.slack.com.evil.example/services/T000/B000/XXXX"],
      ["attacker subdomain on slack", "https://evil.hooks.slack.com/services/T000/B000/XXXX"],
    ])("rejects arbitrary public host: %s", async (_label, url) => {
      await expect(updateSlackWebhook(url)).rejects.toThrow();
      expect(mockUpdate).not.toHaveBeenCalled();
      expect(mockRevalidatePath).not.toHaveBeenCalled();
    });

    it.each([
      ["embedded credentials", "https://user:pass@hooks.slack.com/services/T000/B000/XXXX"],
      ["custom port", "https://hooks.slack.com:8080/services/T000/B000/XXXX"],
      ["query string", "https://hooks.slack.com/services/T000/B000/XXXX?query=1"],
      ["fragment", "https://hooks.slack.com/services/T000/B000/XXXX#fragment"],
    ])("rejects URL authority and parameter attacks: %s", async (_label, url) => {
      await expect(updateSlackWebhook(url)).rejects.toThrow();
      expect(mockUpdate).not.toHaveBeenCalled();
      expect(mockRevalidatePath).not.toHaveBeenCalled();
    });

    it.each([
      ["root path", "https://hooks.slack.com/"],
      ["non-services path", "https://hooks.slack.com/not-services/T000/B000/XXXX"],
      ["api path", "https://hooks.slack.com/api/chat.postMessage"],
    ])("rejects invalid Slack path: %s", async (_label, url) => {
      await expect(updateSlackWebhook(url)).rejects.toThrow();
      expect(mockUpdate).not.toHaveBeenCalled();
      expect(mockRevalidatePath).not.toHaveBeenCalled();
    });
  });

  it.each([
    ["null", null],
    ["an empty string", ""],
    ["whitespace", "   "],
  ])("clears the webhook when given %s", async (_label, value) => {
    await expect(updateSlackWebhook(value)).resolves.toEqual({ success: true });

    expect(mockUpdate).toHaveBeenCalledWith({
      where: { id: "user-1" },
      data: { slackWebhookUrl: null },
    });
  });
});

describe("getSlackWebhook", () => {
  it("returns null without querying when there is no session", async () => {
    session = null;
    await expect(getSlackWebhook()).resolves.toBeNull();
    expect(mockFindUnique).not.toHaveBeenCalled();
  });

  it("reads only the webhook field for the signed-in user", async () => {
    mockFindUnique.mockResolvedValue({ slackWebhookUrl: WEBHOOK });

    await expect(getSlackWebhook()).resolves.toBe(WEBHOOK);
    expect(mockFindUnique).toHaveBeenCalledWith({
      where: { id: "user-1" },
      select: { slackWebhookUrl: true },
    });
  });

  it("returns null when the user row is missing or has no webhook", async () => {
    mockFindUnique.mockResolvedValueOnce(null);
    await expect(getSlackWebhook()).resolves.toBeNull();

    mockFindUnique.mockResolvedValueOnce({ slackWebhookUrl: null });
    await expect(getSlackWebhook()).resolves.toBeNull();
  });
});

describe("getUserRepositoriesWithBadgeStatus", () => {
  it("returns empty array when user is unauthenticated", async () => {
    session = null;
    const res = await getUserRepositoriesWithBadgeStatus();
    expect(res).toEqual([]);
    expect(mockRepoFindMany).not.toHaveBeenCalled();
  });

  it("fetches active user repositories with badge status and latest PR status", async () => {
    mockRepoFindMany.mockResolvedValue([
      {
        id: "repo-1",
        fullName: "acme/api",
        owner: "acme",
        publicBadgeEnabled: true,
        codeScanningEnabled: true,
        codeScanningWarning: null,
        pullRequests: [{ status: "PASS" }],
      },
      {
        id: "repo-2",
        fullName: "acme/web",
        owner: "acme",
        publicBadgeEnabled: false,
        codeScanningEnabled: false,
        codeScanningWarning: "Permission denied",
        pullRequests: [],
      },
    ]);

    const res = await getUserRepositoriesWithBadgeStatus();
    expect(res).toEqual([
      expect.objectContaining({
        id: "repo-1",
        fullName: "acme/api",
        owner: "acme",
        publicBadgeEnabled: true,
        codeScanningEnabled: true,
        codeScanningWarning: null,
        latestStatus: "PASS",
      }),
      expect.objectContaining({
        id: "repo-2",
        fullName: "acme/web",
        owner: "acme",
        publicBadgeEnabled: false,
        codeScanningEnabled: false,
        codeScanningWarning: "Permission denied",
        latestStatus: null,
      }),
    ]);

    expect(mockRepoFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { userId: "user-1", isActive: true },
        orderBy: { fullName: "asc" },
      }),
    );
  });
});

describe("updateRepositoryCodeScanning", () => {
  it("rejects unauthenticated requests", async () => {
    session = null;
    await expect(updateRepositoryCodeScanning("repo-1", true)).rejects.toThrow("Unauthorized");
    expect(mockRepoUpdate).not.toHaveBeenCalled();
  });

  it("returns error if repository not found or not owned by user", async () => {
    mockRepoFindFirst.mockResolvedValue(null);
    const res = await updateRepositoryCodeScanning("repo-ghost", true);
    expect(res).toEqual({ success: false, error: "Repository not found or unauthorized" });
    expect(mockRepoUpdate).not.toHaveBeenCalled();
  });

  it("enables code scanning and revalidates dashboard settings", async () => {
    mockRepoFindFirst.mockResolvedValue({ id: "repo-1", userId: "user-1" });
    mockRepoUpdate.mockResolvedValue({ id: "repo-1", codeScanningEnabled: true });

    const res = await updateRepositoryCodeScanning("repo-1", true);
    expect(res).toEqual({ success: true });
    expect(mockRepoUpdate).toHaveBeenCalledWith({
      where: { id: "repo-1" },
      data: { codeScanningEnabled: true },
    });
    expect(mockRevalidatePath).toHaveBeenCalledWith("/dashboard/settings");
  });

  it("disables code scanning and clears any existing warning", async () => {
    mockRepoFindFirst.mockResolvedValue({ id: "repo-1", userId: "user-1" });
    mockRepoUpdate.mockResolvedValue({
      id: "repo-1",
      codeScanningEnabled: false,
      codeScanningWarning: null,
    });

    const res = await updateRepositoryCodeScanning("repo-1", false);
    expect(res).toEqual({ success: true });
    expect(mockRepoUpdate).toHaveBeenCalledWith({
      where: { id: "repo-1" },
      data: { codeScanningEnabled: false, codeScanningWarning: null },
    });
    expect(mockRevalidatePath).toHaveBeenCalledWith("/dashboard/settings");
  });
});

describe("updateRepositoryPublicBadge", () => {
  it("rejects unauthenticated requests", async () => {
    session = null;
    await expect(updateRepositoryPublicBadge("repo-1", true)).rejects.toThrow("Unauthorized");
    expect(mockRepoUpdate).not.toHaveBeenCalled();
  });

  it("returns error if repository not found or not owned by user", async () => {
    mockRepoFindFirst.mockResolvedValue(null);
    const res = await updateRepositoryPublicBadge("repo-ghost", true);
    expect(res).toEqual({ success: false, error: "Repository not found or unauthorized" });
    expect(mockRepoUpdate).not.toHaveBeenCalled();
  });

  it("updates publicBadgeEnabled and revalidates dashboard settings", async () => {
    mockRepoFindFirst.mockResolvedValue({ id: "repo-1", userId: "user-1" });
    mockRepoUpdate.mockResolvedValue({ id: "repo-1", publicBadgeEnabled: true });

    const res = await updateRepositoryPublicBadge("repo-1", true);
    expect(res).toEqual({ success: true });
    expect(mockRepoUpdate).toHaveBeenCalledWith({
      where: { id: "repo-1" },
      data: { publicBadgeEnabled: true },
    });
    expect(mockRevalidatePath).toHaveBeenCalledWith("/dashboard/settings");
  });
});

describe("Personal API Tokens Server Actions (#1867)", () => {
  describe("getApiTokens", () => {
    it("returns empty array when unauthenticated", async () => {
      session = null;
      const res = await getApiTokens();
      expect(res).toEqual([]);
      expect(mockApiTokenFindMany).not.toHaveBeenCalled();
    });

    it("returns mapped token list without sensitive hash", async () => {
      const now = new Date();
      mockApiTokenFindMany.mockResolvedValueOnce([
        {
          id: "tok-1",
          name: "CLI Token",
          tokenPrefix: "sft_abcdef12",
          scopes: ["findings:read", "scans:write"],
          expiresAt: new Date(Date.now() + 86400000),
          revokedAt: null,
          lastUsedAt: now,
          lastUsedIp: "203.0.113.1",
          createdAt: now,
        },
      ]);

      const res = await getApiTokens();
      expect(res).toHaveLength(1);
      expect(res[0]).toEqual({
        id: "tok-1",
        name: "CLI Token",
        tokenPrefix: "sft_abcdef12",
        scopes: ["findings:read", "scans:write"],
        expiresAt: expect.any(String),
        revokedAt: null,
        lastUsedAt: now.toISOString(),
        lastUsedIp: "203.0.113.1",
        createdAt: now.toISOString(),
      });
      expect(res[0]).not.toHaveProperty("tokenHash");
    });
  });

  describe("createApiToken", () => {
    it("rejects unauthenticated requests", async () => {
      session = null;
      await expect(createApiToken({ name: "My Token", scopes: ["findings:read"] })).rejects.toThrow(
        "Unauthorized",
      );
    });

    it("validates token name", async () => {
      const res1 = await createApiToken({ name: "", scopes: ["findings:read"] });
      expect(res1.success).toBe(false);
      expect(res1.error).toContain("between 1 and 100 characters");

      const res2 = await createApiToken({ name: "   ", scopes: ["findings:read"] });
      expect(res2.success).toBe(false);
    });

    it("validates scopes", async () => {
      const res1 = await createApiToken({ name: "Token", scopes: [] });
      expect(res1.success).toBe(false);
      expect(res1.error).toContain("At least one valid scope");

      const res2 = await createApiToken({ name: "Token", scopes: ["not_real_scope"] });
      expect(res2.success).toBe(false);
    });

    it("validates custom expiry date", async () => {
      const res1 = await createApiToken({
        name: "Token",
        scopes: ["findings:read"],
        customExpiresAt: "invalid-date",
      });
      expect(res1.success).toBe(false);
      expect(res1.error).toContain("valid future date");

      const pastDate = new Date(Date.now() - 3600000).toISOString();
      const res2 = await createApiToken({
        name: "Token",
        scopes: ["findings:read"],
        customExpiresAt: pastDate,
      });
      expect(res2.success).toBe(false);
      expect(res2.error).toContain("valid future date");
    });

    it("creates token, stores only hash, writes audit log, and returns raw token once", async () => {
      const now = new Date();
      mockApiTokenCreate.mockImplementation(async ({ data }) => ({
        id: "tok-new-123",
        userId: data.userId,
        name: data.name,
        tokenHash: data.tokenHash,
        tokenPrefix: data.tokenPrefix,
        scopes: data.scopes,
        expiresAt: data.expiresAt,
        createdAt: now,
      }));

      const res = await createApiToken({
        name: "Production CI",
        scopes: ["scans:write", "findings:read"],
        expiresInDays: 90,
      });

      expect(res.success).toBe(true);
      expect(res.token).toMatch(/^sft_[0-9a-f]{64}$/);
      expect(res.tokenItem).toBeDefined();
      expect(res.tokenItem?.name).toBe("Production CI");
      expect(res.tokenItem?.tokenPrefix).toBe(res.token?.slice(0, 12));

      // Verify DB creation: only tokenHash is stored
      expect(mockApiTokenCreate).toHaveBeenCalledWith({
        data: expect.objectContaining({
          userId: "user-1",
          name: "Production CI",
          tokenHash: expect.any(String),
          tokenPrefix: expect.stringMatching(/^sft_/),
          scopes: ["scans:write", "findings:read"],
          expiresAt: expect.any(Date),
        }),
      });

      // Verify Audit Log entry
      expect(mockAuditLogCreate).toHaveBeenCalledWith({
        data: expect.objectContaining({
          userId: "user-1",
          action: "API_TOKEN_CREATE",
          resource: "api_token:tok-new-123",
          decision: "ALLOW",
          metadata: expect.objectContaining({
            tokenId: "tok-new-123",
            tokenName: "Production CI",
            tokenPrefix: expect.any(String),
            scopes: ["scans:write", "findings:read"],
          }),
        }),
      });
      expect(mockRevalidatePath).toHaveBeenCalledWith("/dashboard/settings");
    });
  });
});

describe("Outbound Webhook Server Actions (#1866)", () => {
  describe("getOutboundWebhooks", () => {
    it("returns empty array when unauthenticated", async () => {
      session = null;
      const res = await getOutboundWebhooks();
      expect(res).toEqual([]);
      expect(mockOutboundWebhookFindMany).not.toHaveBeenCalled();
    });

    it("returns formatted webhooks for authenticated user", async () => {
      const now = new Date();
      mockOutboundWebhookFindMany.mockResolvedValueOnce([
        {
          id: "wh_1",
          url: "https://example.com/webhook",
          events: ["scan.completed"],
          description: "SIEM Hook",
          enabled: true,
          createdAt: now,
          updatedAt: now,
          deliveries: [
            {
              id: "del_1",
              event: "scan.completed",
              statusCode: 200,
              error: null,
              attempts: 1,
              deliveredAt: now,
              createdAt: now,
            },
          ],
        },
      ]);

      const res = await getOutboundWebhooks();
      expect(res).toHaveLength(1);
      expect(res[0].id).toBe("wh_1");
      expect(res[0].url).toBe("https://example.com/webhook");
      expect(res[0].latestDelivery?.statusCode).toBe(200);
      expect(mockOutboundWebhookFindMany).toHaveBeenCalledWith({
        where: { userId: "user-1" },
        orderBy: { createdAt: "desc" },
        include: {
          deliveries: {
            orderBy: { createdAt: "desc" },
            take: 1,
          },
        },
      });
    });
  });

  describe("createOutboundWebhook", () => {
    it("rejects unauthenticated requests", async () => {
      session = null;
      await expect(
        createOutboundWebhook({
          url: "https://example.com/hook",
          events: ["scan.completed"],
        }),
      ).rejects.toThrow("Unauthorized");
    });

    it("rejects SSRF / private URLs", async () => {
      const res = await createOutboundWebhook({
        url: "https://127.0.0.1/hook",
        events: ["scan.completed"],
      });
      expect(res.success).toBe(false);
      expect(res.error).toMatch(/loopback|blocked|private/i);
      expect(mockOutboundWebhookCreate).not.toHaveBeenCalled();
    });

    it("rejects non-HTTPS URLs", async () => {
      const res = await createOutboundWebhook({
        url: "http://example.com/hook",
        events: ["scan.completed"],
      });
      expect(res.success).toBe(false);
      expect(res.error).toContain("must use https:");
      expect(mockOutboundWebhookCreate).not.toHaveBeenCalled();
    });

    it("rejects empty event list", async () => {
      const res = await createOutboundWebhook({
        url: "https://example.com/hook",
        events: [],
      });
      expect(res.success).toBe(false);
      expect(res.error).toContain("at least one event");
      expect(mockOutboundWebhookCreate).not.toHaveBeenCalled();
    });

    it("creates webhook with secure secret and revalidates settings", async () => {
      mockOutboundWebhookCreate.mockResolvedValueOnce({
        id: "wh_new",
        url: "https://webhook.site/abc",
        events: ["scan.completed", "finding.created"],
        description: "My Ticket Bot",
        secret: "whsec_mock",
        enabled: true,
      });

      const res = await createOutboundWebhook({
        url: "https://webhook.site/abc",
        events: ["scan.completed", "finding.created"],
        description: "My Ticket Bot",
      });

      expect(res.success).toBe(true);
      expect(res.webhook?.id).toBe("wh_new");
      expect(res.webhook?.secret).toMatch(/^whsec_[0-9a-f]{64}$/);
      expect(res.webhook?.events).toEqual(["scan.completed", "finding.created"]);
      expect(mockOutboundWebhookCreate).toHaveBeenCalledWith({
        data: expect.objectContaining({
          userId: "user-1",
          url: "https://webhook.site/abc",
          events: ["scan.completed", "finding.created"],
          description: "My Ticket Bot",
          enabled: true,
          secret: expect.stringMatching(/^whsec_[0-9a-f]{64}$/),
        }),
      });
      expect(mockRevalidatePath).toHaveBeenCalledWith("/dashboard/settings");
    });
  });

  describe("revokeApiToken", () => {
    it("rejects unauthenticated requests", async () => {
      session = null;
      await expect(revokeApiToken("tok-1")).rejects.toThrow("Unauthorized");
    });

    it("returns error if token not found or unauthorized", async () => {
      mockApiTokenFindFirst.mockResolvedValueOnce(null);
      const res = await revokeApiToken("tok-missing");
      expect(res.success).toBe(false);
      expect(res.error).toContain("not found or unauthorized");
      expect(mockApiTokenUpdate).not.toHaveBeenCalled();
    });

    it("revokes active token and writes audit log", async () => {
      mockApiTokenFindFirst.mockResolvedValueOnce({
        id: "tok-active",
        userId: "user-1",
        name: "Old Token",
        tokenPrefix: "sft_12345678",
        revokedAt: null,
      });

      const res = await revokeApiToken("tok-active");
      expect(res.success).toBe(true);

      expect(mockApiTokenUpdate).toHaveBeenCalledWith({
        where: { id: "tok-active" },
        data: { revokedAt: expect.any(Date) },
      });

      expect(mockAuditLogCreate).toHaveBeenCalledWith({
        data: expect.objectContaining({
          userId: "user-1",
          action: "API_TOKEN_REVOKE",
          resource: "api_token:tok-active",
          decision: "ALLOW",
          metadata: expect.objectContaining({
            tokenId: "tok-active",
            tokenName: "Old Token",
          }),
        }),
      });

      expect(mockRevalidatePath).toHaveBeenCalledWith("/dashboard/settings");
    });

    it("is idempotent when token is already revoked", async () => {
      mockApiTokenFindFirst.mockResolvedValueOnce({
        id: "tok-already",
        userId: "user-1",
        name: "Already Revoked",
        tokenPrefix: "sft_12345678",
        revokedAt: new Date(),
      });

      const res = await revokeApiToken("tok-already");
      expect(res.success).toBe(true);
      expect(mockApiTokenUpdate).not.toHaveBeenCalled();
    });
  });

  describe("deleteOutboundWebhook", () => {
    it("rejects when webhook not found or not owned by user", async () => {
      mockOutboundWebhookFindFirst.mockResolvedValueOnce(null);
      const res = await deleteOutboundWebhook("wh_ghost");
      expect(res).toEqual({ success: false, error: "Webhook not found or unauthorized." });
      expect(mockOutboundWebhookDelete).not.toHaveBeenCalled();
    });

    it("deletes webhook and revalidates settings", async () => {
      mockOutboundWebhookFindFirst.mockResolvedValueOnce({ id: "wh_1", userId: "user-1" });
      mockOutboundWebhookDelete.mockResolvedValueOnce({ id: "wh_1" });

      const res = await deleteOutboundWebhook("wh_1");
      expect(res).toEqual({ success: true });
      expect(mockOutboundWebhookDelete).toHaveBeenCalledWith({
        where: { id: "wh_1" },
      });
      expect(mockRevalidatePath).toHaveBeenCalledWith("/dashboard/settings");
    });
  });

  describe("toggleOutboundWebhook", () => {
    it("updates enabled state of webhook", async () => {
      mockOutboundWebhookFindFirst.mockResolvedValueOnce({ id: "wh_1", userId: "user-1" });
      mockOutboundWebhookUpdate.mockResolvedValueOnce({ id: "wh_1", enabled: false });

      const res = await toggleOutboundWebhook("wh_1", false);
      expect(res).toEqual({ success: true });
      expect(mockOutboundWebhookUpdate).toHaveBeenCalledWith({
        where: { id: "wh_1" },
        data: { enabled: false },
      });
      expect(mockRevalidatePath).toHaveBeenCalledWith("/dashboard/settings");
    });
  });

  describe("getOutboundWebhookDeliveries", () => {
    it("returns delivery history for owned webhook", async () => {
      mockOutboundWebhookFindFirst.mockResolvedValueOnce({ id: "wh_1", userId: "user-1" });
      const now = new Date();
      mockOutboundDeliveryFindMany.mockResolvedValueOnce([
        {
          id: "del_1",
          webhookId: "wh_1",
          eventId: "evt_1",
          event: "scan.completed",
          statusCode: 200,
          error: null,
          attempts: 1,
          deliveredAt: now,
          createdAt: now,
        },
      ]);

      const res = await getOutboundWebhookDeliveries("wh_1");
      expect(res).toHaveLength(1);
      expect(res[0].eventId).toBe("evt_1");
      expect(res[0].statusCode).toBe(200);
      expect(mockOutboundDeliveryFindMany).toHaveBeenCalledWith({
        where: { webhookId: "wh_1" },
        orderBy: { createdAt: "desc" },
        take: 20,
      });
    });
  });
});
