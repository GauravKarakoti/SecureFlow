import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  recordWebhookDelivery,
  listWebhookDeliveries,
  getWebhookDeliveryStats,
  cleanupOldWebhookDeliveries,
  sanitizeDeliveryError,
  sanitizeRepository,
  _resetDeliveryRateLimitsForTest,
  WEBHOOK_REASON_CODES,
  WEBHOOK_OUTCOMES,
} from "./delivery-recorder";
import prisma from "@/lib/prisma";

describe("Webhook Delivery Diagnostics Recorder (#1928)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    _resetDeliveryRateLimitsForTest();
  });

  describe("Sanitization & Secret Redaction (No payload bodies or secrets stored)", () => {
    it("redacts GitHub tokens, passwords, and private keys from error messages", () => {
      const sensitiveError =
        "Failed to verify signature with token=ghp_123456789012345678901234567890 and Bearer eyJhbGciOiJIUzI1NiJ9";
      const sanitized = sanitizeDeliveryError(sensitiveError);

      expect(sanitized).not.toContain("ghp_123456789012345678901234567890");
      expect(sanitized).toContain("[REDACTED_GITHUB_TOKEN]");
      expect(sanitized).toContain("Bearer [REDACTED_TOKEN]");
    });

    it("redacts private keys and passwords", () => {
      const pemError =
        "Error reading PEM: -----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEA...\n-----END RSA PRIVATE KEY----- password: 'my-super-secret-password'";
      const sanitized = sanitizeDeliveryError(pemError);

      expect(sanitized).not.toContain("MIIEowIBAAKCAQEA");
      expect(sanitized).toContain("[REDACTED_PRIVATE_KEY]");
      expect(sanitized).toContain("[REDACTED_PASSWORD]");
    });

    it("truncates long error messages to 300 characters to prevent database bloat", () => {
      const veryLong = "A".repeat(500);
      const sanitized = sanitizeDeliveryError(veryLong);
      expect(sanitized?.length).toBe(300);
      expect(sanitized?.endsWith("…")).toBe(true);
    });

    it("sanitizes repository names", () => {
      expect(sanitizeRepository("  owner/repo  ")).toBe("owner/repo");
      expect(sanitizeRepository(null)).toBeNull();
      const longRepo = "a".repeat(200);
      expect(sanitizeRepository(longRepo)?.length).toBe(150);
    });
  });

  describe("Recording Deliveries", () => {
    it("records an accepted queued delivery", async () => {
      vi.mocked(prisma.webhookDelivery.create).mockResolvedValueOnce({
        id: "del-1",
        deliveryId: "github-delivery-100",
        eventType: "pull_request",
        action: "opened",
        repository: "acme/corp",
        outcome: "queued",
        reasonCode: WEBHOOK_REASON_CODES.QUEUED,
        error: null,
        createdAt: new Date(),
      } as any);

      const success = await recordWebhookDelivery({
        deliveryId: "github-delivery-100",
        eventType: "pull_request",
        action: "opened",
        repository: "acme/corp",
        outcome: "queued",
        reasonCode: WEBHOOK_REASON_CODES.QUEUED,
      });

      expect(success).toBe(true);
      expect(prisma.webhookDelivery.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          deliveryId: "github-delivery-100",
          eventType: "pull_request",
          action: "opened",
          repository: "acme/corp",
          outcome: "queued",
          reasonCode: "QUEUED",
        }),
      });
    });

    it("records an accepted scanned delivery and updates in-flight record if queued", async () => {
      vi.mocked(prisma.webhookDelivery.findFirst).mockResolvedValueOnce({
        id: "del-1",
        deliveryId: "github-delivery-101",
        outcome: "queued",
        action: "synchronize",
        repository: "acme/corp",
      } as any);
      vi.mocked(prisma.webhookDelivery.update).mockResolvedValueOnce({} as any);

      const success = await recordWebhookDelivery({
        deliveryId: "github-delivery-101",
        eventType: "pull_request",
        action: "synchronize",
        repository: "acme/corp",
        outcome: "scanned",
        reasonCode: WEBHOOK_REASON_CODES.SCANNED,
      });

      expect(success).toBe(true);
      expect(prisma.webhookDelivery.update).toHaveBeenCalledWith({
        where: { id: "del-1" },
        data: expect.objectContaining({
          outcome: "scanned",
          reasonCode: "SCANNED",
        }),
      });
    });

    it("records an ignored delivery (e.g. DRAFT_PR, REPO_DISABLED, PING, UNTRACKED_EVENT)", async () => {
      vi.mocked(prisma.webhookDelivery.create).mockResolvedValueOnce({} as any);

      const success = await recordWebhookDelivery({
        deliveryId: "github-delivery-102",
        eventType: "pull_request",
        action: "opened",
        repository: "acme/corp",
        outcome: "ignored",
        reasonCode: WEBHOOK_REASON_CODES.DRAFT_PR,
        error: "Draft pull request skipped",
      });

      expect(success).toBe(true);
      expect(prisma.webhookDelivery.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          deliveryId: "github-delivery-102",
          outcome: "ignored",
          reasonCode: "DRAFT_PR",
        }),
      });
    });

    it("records a rejected delivery (e.g. BAD_SIGNATURE)", async () => {
      vi.mocked(prisma.webhookDelivery.create).mockResolvedValueOnce({} as any);

      const success = await recordWebhookDelivery({
        deliveryId: "github-delivery-103",
        eventType: "pull_request",
        outcome: "rejected",
        reasonCode: WEBHOOK_REASON_CODES.BAD_SIGNATURE,
        error: "Invalid GitHub webhook signature",
      });

      expect(success).toBe(true);
      expect(prisma.webhookDelivery.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          deliveryId: "github-delivery-103",
          outcome: "rejected",
          reasonCode: "BAD_SIGNATURE",
          error: "Invalid GitHub webhook signature",
        }),
      });
    });

    it("handles missing required fields cleanly without throwing", async () => {
      const success = await recordWebhookDelivery({
        deliveryId: "",
        eventType: "",
        outcome: "rejected",
        reasonCode: "BAD_SIGNATURE",
      });
      expect(success).toBe(false);
      expect(prisma.webhookDelivery.create).not.toHaveBeenCalled();
    });
  });

  describe("Write Rate Limiting (Flood protection)", () => {
    it("rate limits rejected delivery writes to protect the database during attack floods", async () => {
      vi.mocked(prisma.webhookDelivery.create).mockResolvedValue({} as any);

      // Simulate 60 rejected writes (the limit)
      for (let i = 0; i < 60; i++) {
        const res = await recordWebhookDelivery({
          deliveryId: `flood-${i}`,
          eventType: "pull_request",
          outcome: "rejected",
          reasonCode: WEBHOOK_REASON_CODES.BAD_SIGNATURE,
        });
        expect(res).toBe(true);
      }

      // 61st write must be rate-limited and dropped
      const blocked = await recordWebhookDelivery({
        deliveryId: "flood-61",
        eventType: "pull_request",
        outcome: "rejected",
        reasonCode: WEBHOOK_REASON_CODES.BAD_SIGNATURE,
      });

      expect(blocked).toBe(false);
      // create should only have been called 60 times
      expect(prisma.webhookDelivery.create).toHaveBeenCalledTimes(60);
    });
  });

  describe("7-Day Retention Cleanup", () => {
    it("deletes records older than retention window (default 7 days)", async () => {
      vi.mocked(prisma.webhookDelivery.deleteMany).mockResolvedValueOnce({ count: 42 });

      const deletedCount = await cleanupOldWebhookDeliveries(7);

      expect(deletedCount).toBe(42);
      expect(prisma.webhookDelivery.deleteMany).toHaveBeenCalledWith({
        where: {
          createdAt: {
            lt: expect.any(Date),
          },
        },
      });
    });
  });

  describe("Querying & Filtering Diagnostics", () => {
    it("filters deliveries by repository, outcome and date range", async () => {
      const mockRows = [
        {
          id: "1",
          deliveryId: "del-1",
          eventType: "pull_request",
          repository: "owner/repo",
          outcome: "scanned",
          reasonCode: "SCANNED",
          createdAt: new Date(),
        },
      ];
      vi.mocked(prisma.webhookDelivery.findMany).mockResolvedValueOnce(mockRows as any);
      vi.mocked(prisma.webhookDelivery.count).mockResolvedValueOnce(1);

      const result = await listWebhookDeliveries({
        repository: "owner/repo",
        outcome: "scanned",
      });

      expect(result.deliveries).toEqual(mockRows);
      expect(result.total).toBe(1);
      expect(prisma.webhookDelivery.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            outcome: "scanned",
            repository: {
              contains: "owner/repo",
              mode: "insensitive",
            },
          }),
        }),
      );
    });

    it("aggregates stats per outcome", async () => {
      vi.mocked(prisma.webhookDelivery.groupBy).mockResolvedValueOnce([
        { outcome: "scanned", _count: { _all: 10 } },
        { outcome: "queued", _count: { _all: 3 } },
        { outcome: "ignored", _count: { _all: 5 } },
        { outcome: "rejected", _count: { _all: 2 } },
      ] as any);

      const stats = await getWebhookDeliveryStats(7);

      expect(stats.total).toBe(20);
      expect(stats.scanned).toBe(10);
      expect(stats.queued).toBe(3);
      expect(stats.ignored).toBe(5);
      expect(stats.rejected).toBe(2);
    });
  });
});
