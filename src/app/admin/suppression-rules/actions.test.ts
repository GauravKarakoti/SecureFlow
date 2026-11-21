import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  createSuppressionRuleAction,
  updateSuppressionRuleAction,
  deleteSuppressionRuleAction,
  getSuppressionRulesAction,
} from "./actions";

vi.mock("@/auth", () => ({
  auth: vi.fn(),
}));

vi.mock("@/lib/prisma", () => ({
  default: {
    suppressionRule: {
      findMany: vi.fn(),
      findUnique: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      delete: vi.fn(),
    },
    suppressionRuleEvent: {
      groupBy: vi.fn(),
      createMany: vi.fn(),
    },
    auditLog: {
      create: vi.fn(),
    },
  },
}));

vi.mock("next/cache", () => ({
  revalidatePath: vi.fn(),
}));

describe("Suppression Rules Admin Actions (#1891)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("Permission Checks (Non-admin rejection)", () => {
    it("rejects unauthenticated requests", async () => {
      const { auth } = await import("@/auth");
      vi.mocked(auth).mockResolvedValue(null);

      await expect(
        createSuppressionRuleAction({
          name: "Test",
          scope: "ALL",
          reason: "Test",
        }),
      ).rejects.toThrow("Forbidden");

      await expect(updateSuppressionRuleAction("rule-1", { name: "Updated" })).rejects.toThrow(
        "Forbidden",
      );

      await expect(deleteSuppressionRuleAction("rule-1")).rejects.toThrow("Forbidden");

      await expect(getSuppressionRulesAction()).rejects.toThrow("Forbidden");
    });

    it("rejects non-admin users (role USER)", async () => {
      const { auth } = await import("@/auth");
      vi.mocked(auth).mockResolvedValue({
        user: { id: "user-1", email: "user@example.com", roles: ["USER"] },
      } as any);

      await expect(
        createSuppressionRuleAction({
          name: "Test",
          scope: "ALL",
          reason: "Test",
        }),
      ).rejects.toThrow("Forbidden: Admin role required");

      await expect(updateSuppressionRuleAction("rule-1", { name: "Updated" })).rejects.toThrow(
        "Forbidden: Admin role required",
      );

      await expect(deleteSuppressionRuleAction("rule-1")).rejects.toThrow(
        "Forbidden: Admin role required",
      );
    });
  });

  describe("Admin Success & Audit Logging", () => {
    beforeEach(async () => {
      const { auth } = await import("@/auth");
      vi.mocked(auth).mockResolvedValue({
        user: { id: "admin-1", email: "admin@example.com", roles: ["ADMIN"] },
      } as any);
    });

    it("allows admin to create rule and records audit log", async () => {
      const prisma = (await import("@/lib/prisma")).default;
      const mockCreated = {
        id: "rule-100",
        name: "Suppress test fixtures",
        scope: "ALL",
        reason: "Test fixture ignore",
        createdAt: new Date(),
        updatedAt: new Date(),
      };
      vi.mocked(prisma.suppressionRule.create).mockResolvedValue(mockCreated as any);
      vi.mocked(prisma.auditLog.create).mockResolvedValue({} as any);

      const res = await createSuppressionRuleAction({
        name: "Suppress test fixtures",
        scope: "ALL",
        reason: "Test fixture ignore",
        pathGlob: "fixtures/**",
      });

      expect(res.id).toBe("rule-100");
      expect(prisma.suppressionRule.create).toHaveBeenCalledTimes(1);
      expect(prisma.auditLog.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            userId: "admin-1",
            action: "SUPPRESSION_RULE_CREATE",
            resource: "rule-100",
          }),
        }),
      );
    });

    it("allows admin to update rule and records audit log", async () => {
      const prisma = (await import("@/lib/prisma")).default;
      const mockUpdated = {
        id: "rule-100",
        name: "Updated Name",
        scope: "ALL",
        reason: "Updated reason",
        updatedAt: new Date(),
      };
      vi.mocked(prisma.suppressionRule.update).mockResolvedValue(mockUpdated as any);
      vi.mocked(prisma.auditLog.create).mockResolvedValue({} as any);

      const res = await updateSuppressionRuleAction("rule-100", {
        name: "Updated Name",
        reason: "Updated reason",
      });

      expect(res.name).toBe("Updated Name");
      expect(prisma.suppressionRule.update).toHaveBeenCalledTimes(1);
      expect(prisma.auditLog.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            userId: "admin-1",
            action: "SUPPRESSION_RULE_UPDATE",
            resource: "rule-100",
          }),
        }),
      );
    });

    it("allows admin to delete rule and records audit log", async () => {
      const prisma = (await import("@/lib/prisma")).default;
      const mockDeleted = {
        id: "rule-100",
        name: "To Delete",
        reason: "Temporary",
      };
      vi.mocked(prisma.suppressionRule.delete).mockResolvedValue(mockDeleted as any);
      vi.mocked(prisma.auditLog.create).mockResolvedValue({} as any);

      const res = await deleteSuppressionRuleAction("rule-100");

      expect(res.id).toBe("rule-100");
      expect(prisma.suppressionRule.delete).toHaveBeenCalledTimes(1);
      expect(prisma.auditLog.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            userId: "admin-1",
            action: "SUPPRESSION_RULE_DELETE",
            resource: "rule-100",
          }),
        }),
      );
    });
  });
});
