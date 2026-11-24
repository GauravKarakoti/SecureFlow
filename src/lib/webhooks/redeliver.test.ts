import { describe, it, expect, vi, beforeEach } from "vitest";
import prisma from "@/lib/prisma";
import { isDeliveryEligibleForRedelivery, redeliverWebhookDelivery } from "./redeliver";
import * as redisModule from "@/lib/redis";

vi.mock("@/auth", () => ({
  auth: vi.fn().mockResolvedValue({
    user: {
      id: "admin-user-1",
      name: "Admin User",
      roles: ["ADMIN"],
    },
  }),
}));

vi.mock("@/lib/prisma", () => ({
  default: {
    webhookDelivery: {
      findFirst: vi.fn(),
    },
    auditLog: {
      create: vi.fn().mockResolvedValue({ id: "audit-1" }),
    },
  },
}));

vi.mock("@/lib/github/app-auth", () => ({
  createGitHubAppClient: vi.fn(),
}));

describe("Webhook Redelivery Service (#2013)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    redisModule.resetMemoryStore();
  });

  describe("isDeliveryEligibleForRedelivery", () => {
    it("returns true for rejected deliveries", () => {
      expect(
        isDeliveryEligibleForRedelivery({ outcome: "rejected", reasonCode: "BAD_SIGNATURE" }),
      ).toBe(true);
      expect(isDeliveryEligibleForRedelivery({ outcome: "rejected", reasonCode: "UNKNOWN" })).toBe(
        true,
      );
    });

    it("returns true for REPO_DISABLED and SCAN_FAILED reason codes", () => {
      expect(
        isDeliveryEligibleForRedelivery({ outcome: "ignored", reasonCode: "REPO_DISABLED" }),
      ).toBe(true);
      expect(
        isDeliveryEligibleForRedelivery({ outcome: "scanned", reasonCode: "SCAN_FAILED" }),
      ).toBe(true);
      expect(
        isDeliveryEligibleForRedelivery({ outcome: "rejected", reasonCode: "RATE_LIMITED" }),
      ).toBe(true);
    });

    it("returns false for healthy processed or skipped non-retryable events", () => {
      expect(isDeliveryEligibleForRedelivery({ outcome: "scanned", reasonCode: "SCANNED" })).toBe(
        false,
      );
      expect(isDeliveryEligibleForRedelivery({ outcome: "queued", reasonCode: "QUEUED" })).toBe(
        false,
      );
      expect(isDeliveryEligibleForRedelivery({ outcome: "ignored", reasonCode: "PING" })).toBe(
        false,
      );
      expect(isDeliveryEligibleForRedelivery({ outcome: "ignored", reasonCode: "DRAFT_PR" })).toBe(
        false,
      );
    });
  });

  describe("redeliverWebhookDelivery", () => {
    it("rejects non-admin requests with 403", async () => {
      const { auth } = await import("@/auth");
      vi.mocked(auth).mockResolvedValueOnce({
        user: {
          id: "member-1",
          name: "Regular User",
          roles: ["DEVELOPER"],
        },
      } as any);

      const result = await redeliverWebhookDelivery("del-test-123");
      expect(result.success).toBe(false);
      expect(result.statusCode).toBe(403);
      expect(result.message).toContain("Admin access required");
      expect(prisma.auditLog.create).not.toHaveBeenCalled();
    });

    it("requires a delivery ID", async () => {
      const result = await redeliverWebhookDelivery("   ");
      expect(result.success).toBe(false);
      expect(result.statusCode).toBe(400);
    });

    it("successfully calls GitHub App redeliver API and writes audit log", async () => {
      const mockRequest = vi.fn().mockResolvedValue({ status: 202 });
      const mockAppClient = {
        octokit: {
          request: mockRequest,
        },
      };

      vi.mocked(prisma.webhookDelivery.findFirst).mockResolvedValueOnce({
        id: "rec-1",
        deliveryId: "del-success-123",
        repository: "acme/repo",
        eventType: "pull_request",
        outcome: "rejected",
        reasonCode: "REPO_DISABLED",
        error: "Repository disabled",
        createdAt: new Date(),
        action: null,
      });

      const result = await redeliverWebhookDelivery("del-success-123", {
        appClient: mockAppClient,
      });

      expect(result.success).toBe(true);
      expect(result.statusCode).toBe(202);
      expect(mockRequest).toHaveBeenCalledWith(
        "POST /app/hook/deliveries/{delivery_id}/attempts",
        expect.objectContaining({
          delivery_id: "del-success-123",
        }),
      );

      expect(prisma.auditLog.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          userId: "admin-user-1",
          action: "WEBHOOK_REDELIVER",
          resource: "webhook_delivery:del-success-123",
          decision: "ACCEPTED",
          metadata: expect.objectContaining({
            deliveryId: "del-success-123",
            repository: "acme/repo",
            statusCode: 202,
          }),
        }),
      });
    });

    it("handles GitHub permission errors (403) and audits the failure", async () => {
      const mockRequest = vi.fn().mockRejectedValue({
        status: 403,
        message: "Resource not accessible by integration",
      });
      const mockAppClient = {
        octokit: {
          request: mockRequest,
        },
      };

      const result = await redeliverWebhookDelivery("del-perm-error", {
        appClient: mockAppClient,
      });

      expect(result.success).toBe(false);
      expect(result.statusCode).toBe(403);
      expect(result.message).toContain("GitHub App missing permissions");

      expect(prisma.auditLog.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          action: "WEBHOOK_REDELIVER",
          decision: "REJECTED",
          metadata: expect.objectContaining({
            deliveryId: "del-perm-error",
            statusCode: 403,
          }),
        }),
      });
    });

    it("handles delivery older than 3 days / not found (404)", async () => {
      const mockRequest = vi.fn().mockRejectedValue({
        status: 404,
        message: "Not Found",
      });
      const mockAppClient = {
        octokit: {
          request: mockRequest,
        },
      };

      const result = await redeliverWebhookDelivery("del-expired", {
        appClient: mockAppClient,
      });

      expect(result.success).toBe(false);
      expect(result.statusCode).toBe(404);
      expect(result.message).toContain("GitHub retains webhook deliveries for up to 3 days");
    });

    it("rate limits redelivery attempts per admin", async () => {
      const mockRequest = vi.fn().mockResolvedValue({ status: 202 });
      const mockAppClient = { octokit: { request: mockRequest } };

      // Consume full quota of 10
      for (let i = 0; i < 10; i++) {
        const res = await redeliverWebhookDelivery(`del-${i}`, { appClient: mockAppClient });
        expect(res.success).toBe(true);
      }

      // 11th should be rate-limited (429)
      const throttled = await redeliverWebhookDelivery("del-11", { appClient: mockAppClient });
      expect(throttled.success).toBe(false);
      expect(throttled.statusCode).toBe(429);
      expect(throttled.message).toContain("Rate limit exceeded");
    });
  });
});
