import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  createSuppressionRuleAction,
  updateSuppressionRuleAction,
  renewSuppressionRuleAction,
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
      updateManyAndReturn: vi.fn(),
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
      await expect(renewSuppressionRuleAction("rule-1", "2030-01-01")).rejects.toThrow("Forbidden");

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
      await expect(renewSuppressionRuleAction("rule-1", "2030-01-01")).rejects.toThrow("Forbidden");

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
      vi.mocked(prisma.suppressionRule.updateManyAndReturn).mockResolvedValue([mockUpdated as any]);
      vi.mocked(prisma.auditLog.create).mockResolvedValue({} as any);

      const res = await updateSuppressionRuleAction("rule-100", {
        name: "Updated Name",
        reason: "Updated reason",
      });

      expect(res).toMatchObject({ name: "Updated Name" });
      expect(prisma.suppressionRule.updateManyAndReturn).toHaveBeenCalledTimes(1);
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

  describe("Expiry transitions", () => {
    const now = new Date("2026-11-22T12:00:00Z");
    const previousExpiry = new Date("2026-11-22T11:00:00Z");

    beforeEach(async () => {
      vi.useFakeTimers();
      vi.setSystemTime(now);
      const { auth } = await import("@/auth");
      vi.mocked(auth).mockResolvedValue({
        user: { id: "admin-1", roles: ["ADMIN"] },
      } as Awaited<ReturnType<typeof auth>>);
    });

    afterEach(() => vi.useRealTimers());

    it("rejects ordinary edits when the rule expired or changed while the editor was open", async () => {
      const { default: prisma } = await import("@/lib/prisma");
      vi.mocked(prisma.suppressionRule.updateManyAndReturn).mockResolvedValue([]);

      const result = await updateSuppressionRuleAction(
        "rule-1",
        { name: "Stale edit" },
        previousExpiry,
      );

      expect(result).toMatchObject({ error: expect.stringContaining("expired or changed") });
      expect(prisma.suppressionRule.updateManyAndReturn).toHaveBeenCalledWith({
        where: {
          id: "rule-1",
          expiresAt: previousExpiry,
          OR: [{ expiresAt: null }, { expiresAt: { gt: now } }],
        },
        data: { name: "Stale edit" },
      });
      expect(prisma.auditLog.create).not.toHaveBeenCalled();
    });

    it.each(["", "2026-11-21", "2026-11-22", "2027-02-30", "2026-11-23T00:00:00Z"])(
      "rejects invalid or elapsed renewal date %j before writing",
      async (expiryDate) => {
        const { default: prisma } = await import("@/lib/prisma");
        const result = await renewSuppressionRuleAction("rule-1", expiryDate);
        expect(result).toEqual({ error: "Choose a future expiry date (UTC)." });
        expect(prisma.suppressionRule.updateManyAndReturn).not.toHaveBeenCalled();
      },
    );

    it("renews only the expiry and audits the change", async () => {
      const { default: prisma } = await import("@/lib/prisma");
      const expiresAt = new Date("2026-12-01T00:00:00Z");
      const rule = { id: "rule-1", expiresAt, reason: "Original criteria" };
      vi.mocked(prisma.suppressionRule.updateManyAndReturn).mockResolvedValue([
        rule as Awaited<ReturnType<typeof prisma.suppressionRule.update>>,
      ]);

      await expect(renewSuppressionRuleAction("rule-1", "2026-12-01")).resolves.toEqual(rule);
      expect(prisma.suppressionRule.updateManyAndReturn).toHaveBeenCalledWith({
        where: { id: "rule-1", expiresAt: { lte: now } },
        data: { expiresAt },
      });
      expect(prisma.auditLog.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          userId: "admin-1",
          resource: "rule-1",
          metadata: expect.objectContaining({ expiresAt: expiresAt.toISOString() }),
        }),
      });
    });

    it("does not write audit entries when renewal loses a race to another administrator", async () => {
      const { default: prisma } = await import("@/lib/prisma");
      vi.mocked(prisma.suppressionRule.updateManyAndReturn).mockResolvedValue([]);

      await expect(renewSuppressionRuleAction("rule-1", "2026-12-01")).resolves.toMatchObject({
        error: expect.stringContaining("no longer expired"),
      });
      expect(prisma.auditLog.create).not.toHaveBeenCalled();
    });
  });
});
