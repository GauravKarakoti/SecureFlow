import { describe, it, expect, vi, beforeEach } from "vitest";
import { getOnboardingStatus, sendTestWebhookEvent } from "./onboarding";

const {
  authMock,
  revalidatePathMock,
  prismaWebhookEventCountMock,
  prismaWebhookEventCreateMock,
  prismaPolicyTemplateFindManyMock,
  prismaUserPolicyToggleFindManyMock,
  prismaRepositoryFindFirstMock,
} = vi.hoisted(() => ({
  authMock: vi.fn(),
  revalidatePathMock: vi.fn(),
  prismaWebhookEventCountMock: vi.fn(),
  prismaWebhookEventCreateMock: vi.fn(),
  prismaPolicyTemplateFindManyMock: vi.fn(),
  prismaUserPolicyToggleFindManyMock: vi.fn(),
  prismaRepositoryFindFirstMock: vi.fn(),
}));

vi.mock("@/auth", () => ({
  auth: authMock,
}));

vi.mock("next/cache", () => ({
  revalidatePath: revalidatePathMock,
}));

vi.mock("@/lib/prisma", () => ({
  default: {
    webhookEvent: {
      count: prismaWebhookEventCountMock,
      create: prismaWebhookEventCreateMock,
    },
    policyTemplate: {
      findMany: prismaPolicyTemplateFindManyMock,
    },
    userPolicyToggle: {
      findMany: prismaUserPolicyToggleFindManyMock,
    },
    repository: {
      findFirst: prismaRepositoryFindFirstMock,
    },
  },
}));

describe("src/lib/actions/onboarding.ts (#1787)", () => {
  const originalEnv = process.env;

  beforeEach(() => {
    vi.clearAllMocks();
    process.env = { ...originalEnv };
  });

  describe("getOnboardingStatus", () => {
    it("returns allComplete: true when all 5 criteria are satisfied", async () => {
      prismaWebhookEventCountMock.mockResolvedValueOnce(3);
      prismaPolicyTemplateFindManyMock.mockResolvedValueOnce([{ id: "tmpl-1", isDefault: true }]);
      prismaUserPolicyToggleFindManyMock.mockResolvedValueOnce([]);

      const status = await getOnboardingStatus("usr-1", false, 2, 5);

      expect(status).toEqual({
        appInstalled: true,
        repoConnected: true,
        webhookReceived: true,
        policyEnabled: true,
        firstScanCompleted: true,
        allComplete: true,
      });
    });

    it("evaluates custom policy toggles correctly", async () => {
      prismaWebhookEventCountMock.mockResolvedValueOnce(0);
      prismaPolicyTemplateFindManyMock.mockResolvedValueOnce([
        { id: "tmpl-1", isDefault: false },
        { id: "tmpl-2", isDefault: true },
      ]);
      // User explicitly toggled off tmpl-2, but toggled on tmpl-1
      prismaUserPolicyToggleFindManyMock.mockResolvedValueOnce([
        { policyTemplateId: "tmpl-2", isActive: false },
        { policyTemplateId: "tmpl-1", isActive: true },
      ]);

      const status = await getOnboardingStatus("usr-2", true, 0, 0);

      expect(status).toEqual({
        appInstalled: false,
        repoConnected: false,
        webhookReceived: false,
        policyEnabled: true,
        firstScanCompleted: false,
        allComplete: false,
      });
    });

    it("evaluates policyEnabled as false when all default policies are toggled off", async () => {
      prismaWebhookEventCountMock.mockResolvedValueOnce(1);
      prismaPolicyTemplateFindManyMock.mockResolvedValueOnce([
        { id: "tmpl-default", isDefault: true },
      ]);
      prismaUserPolicyToggleFindManyMock.mockResolvedValueOnce([
        { policyTemplateId: "tmpl-default", isActive: false },
      ]);

      const status = await getOnboardingStatus("usr-3", false, 1, 0);

      expect(status.policyEnabled).toBe(false);
      expect(status.allComplete).toBe(false);
    });
  });

  describe("sendTestWebhookEvent", () => {
    it("returns error if user is unauthenticated", async () => {
      authMock.mockResolvedValueOnce(null);

      const result = await sendTestWebhookEvent();
      expect(result.success).toBe(false);
      expect(result.error).toContain("Authentication Required");
    });

    it("returns error if GITHUB_WEBHOOK_SECRET is not configured", async () => {
      authMock.mockResolvedValueOnce({ user: { id: "user-123", name: "Alice" } });
      delete process.env.GITHUB_WEBHOOK_SECRET;

      const result = await sendTestWebhookEvent();
      expect(result.success).toBe(false);
      expect(result.error).toContain("GITHUB_WEBHOOK_SECRET is not configured");
    });

    it("creates a test webhook event and verifies signature successfully", async () => {
      process.env.GITHUB_WEBHOOK_SECRET = "super-test-secret-value";
      authMock.mockResolvedValueOnce({
        user: { id: "user-123", name: "Alice", githubLogin: "alice-dev" },
      });
      prismaRepositoryFindFirstMock.mockResolvedValueOnce({
        id: "repo-1",
        fullName: "alice-dev/my-app",
        owner: "alice-dev",
        githubId: BigInt(987654),
      });
      prismaWebhookEventCreateMock.mockResolvedValueOnce({ id: "evt-1" });

      const result = await sendTestWebhookEvent();

      expect(result.success).toBe(true);
      expect(result.message).toContain("Webhook delivery received and HMAC signature verified");
      expect(result.deliveryId).toBeDefined();

      expect(prismaWebhookEventCreateMock).toHaveBeenCalledWith({
        data: {
          deliveryId: result.deliveryId,
          repositoryId: "repo-1",
        },
      });
      expect(revalidatePathMock).toHaveBeenCalledWith("/dashboard");
    });

    it("handles database insertion error with readable message", async () => {
      process.env.GITHUB_WEBHOOK_SECRET = "super-test-secret-value";
      authMock.mockResolvedValueOnce({ user: { id: "user-123" } });
      prismaRepositoryFindFirstMock.mockResolvedValueOnce(null);
      prismaWebhookEventCreateMock.mockRejectedValueOnce(new Error("Database connection timeout"));

      const result = await sendTestWebhookEvent();

      expect(result.success).toBe(false);
      expect(result.error).toContain("Database Error");
      expect(result.error).toContain("Database connection timeout");
    });
  });
});
