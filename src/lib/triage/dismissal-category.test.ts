import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  setFindingStatus,
  setFindingStatuses,
  migrateUnspecifiedDismissals,
} from "@/lib/actions/triage";
import {
  aggregateDismissals,
  buildCategoryBreakdown,
  getDismissalReport,
} from "@/lib/triage/dismissal-report";
import { DISMISSAL_REASONS, isDismissalReason } from "@/lib/triage/statuses";
import prisma from "@/lib/prisma";

vi.mock("@/auth", () => ({
  auth: vi.fn().mockResolvedValue({
    user: { id: "user-123", email: "user@example.com", role: "ADMIN" },
  }),
}));

vi.mock("@/lib/auth/permissions", () => ({
  can: vi.fn().mockReturnValue(true),
}));

vi.mock("next/cache", () => ({
  revalidatePath: vi.fn(),
}));

vi.mock("@/lib/audit/user-filter-cache", () => ({
  invalidateCachedUserFilters: vi.fn(),
}));

vi.mock("@/lib/triage/reconcile", () => ({
  reconcileTriageVerdicts: vi.fn().mockResolvedValue({ updated: 1, pending: 0 }),
}));

vi.mock("@/lib/prisma", () => ({
  default: {
    repository: {
      findFirst: vi.fn(),
      findMany: vi.fn(),
    },
    findingTriage: {
      upsert: vi.fn().mockResolvedValue({}),
      updateMany: vi.fn().mockResolvedValue({ count: 5 }),
      findMany: vi.fn().mockResolvedValue([]),
    },
    finding: {
      findMany: vi.fn().mockResolvedValue([]),
    },
    auditLog: {
      create: vi.fn().mockResolvedValue({}),
    },
  },
}));

describe("Structured Dismissal Reasons & Reporting (#2096)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("Validation: A dismissal cannot be saved without a category", () => {
    it("rejects dismissal without category/reason", async () => {
      const result = await setFindingStatus({
        repositoryId: "repo-1",
        fingerprint: "fp-1",
        status: "DISMISSED",
        reason: null,
      });

      expect(result.ok).toBe(false);
      expect(result.error).toBe("Dismissal reason category is required");
      expect(prisma.findingTriage.upsert).not.toHaveBeenCalled();
    });

    it("rejects dismissal with invalid category", async () => {
      const result = await setFindingStatus({
        repositoryId: "repo-1",
        fingerprint: "fp-1",
        status: "DISMISSED",
        reason: "NOT_A_VALID_CATEGORY" as any,
      });

      expect(result.ok).toBe(false);
      expect(result.error).toBe("Invalid dismissal reason category");
      expect(prisma.findingTriage.upsert).not.toHaveBeenCalled();
    });

    it("accepts valid category (e.g. TEST_CODE, MITIGATED_ELSEWHERE, ACCEPTED_RISK, FALSE_POSITIVE)", async () => {
      (prisma.repository.findFirst as any).mockResolvedValueOnce({
        id: "repo-1",
        fullName: "acme/repo",
      });

      const result = await setFindingStatus({
        repositoryId: "repo-1",
        fingerprint: "fp-1",
        status: "DISMISSED",
        category: "TEST_CODE",
        note: "Unit test mock secret",
      });

      expect(result.ok).toBe(true);
      expect(prisma.findingTriage.upsert).toHaveBeenCalledWith(
        expect.objectContaining({
          update: expect.objectContaining({
            dismissalReason: "TEST_CODE",
            note: "Unit test mock secret",
          }),
        }),
      );
    });

    it("rejects bulk dismissal without a category", async () => {
      const result = await setFindingStatuses({
        items: [{ repositoryId: "repo-1", fingerprint: "fp-1" }],
        status: "DISMISSED",
        reason: null,
      });

      expect(result.ok).toBe(false);
      expect(result.error).toBe("Dismissal reason category is required");
    });
  });

  describe("Migration: Existing dismissals keep working under 'unspecified'", () => {
    it("migrates dismissals with null category to UNSPECIFIED", async () => {
      (prisma.findingTriage.updateMany as any).mockResolvedValueOnce({ count: 12 });

      const migrationResult = await migrateUnspecifiedDismissals();
      expect(migrationResult.updatedCount).toBe(12);
      expect(prisma.findingTriage.updateMany).toHaveBeenCalledWith({
        where: {
          status: { in: ["DISMISSED", "FALSE_POSITIVE", "IGNORED"] },
          dismissalReason: null,
        },
        data: {
          dismissalReason: "UNSPECIFIED",
        },
      });
    });

    it("allows UNSPECIFIED as a valid dismissal reason category", () => {
      expect(isDismissalReason("UNSPECIFIED")).toBe(true);
      expect(DISMISSAL_REASONS).toContain("UNSPECIFIED");
    });
  });

  describe("Report: Counts match underlying data and group by category & policy", () => {
    it("aggregates dismissals by category accurately", () => {
      const records = [
        { fingerprint: "fp-1", dismissalReason: "FALSE_POSITIVE", findingType: "SQL Injection" },
        { fingerprint: "fp-2", dismissalReason: "FALSE_POSITIVE", findingType: "SQL Injection" },
        { fingerprint: "fp-3", dismissalReason: "TEST_CODE", findingType: "SQL Injection" },
        { fingerprint: "fp-4", dismissalReason: "ACCEPTED_RISK", findingType: "Hardcoded Secret" },
        { fingerprint: "fp-5", dismissalReason: "MITIGATED_ELSEWHERE", findingType: "Hardcoded Secret" },
        { fingerprint: "fp-6", dismissalReason: null, findingType: "Hardcoded Secret" }, // maps to UNSPECIFIED
      ];

      const report = aggregateDismissals(records);

      expect(report.totalDismissals).toBe(6);
      expect(report.byCategory.FALSE_POSITIVE).toBe(2);
      expect(report.byCategory.TEST_CODE).toBe(1);
      expect(report.byCategory.ACCEPTED_RISK).toBe(1);
      expect(report.byCategory.MITIGATED_ELSEWHERE).toBe(1);
      expect(report.byCategory.UNSPECIFIED).toBe(1);

      // Check category breakdown percentages
      const fpCat = report.categoryBreakdown.find((c) => c.category === "FALSE_POSITIVE");
      expect(fpCat?.count).toBe(2);
      expect(fpCat?.percentage).toBe(33.3);

      // Check policy breakdown
      expect(report.byPolicy).toHaveLength(2);
      const sqlPolicy = report.byPolicy.find((p) => p.policyName === "SQL Injection");
      expect(sqlPolicy?.totalDismissals).toBe(3);
      expect(sqlPolicy?.byCategory.FALSE_POSITIVE).toBe(2);
      expect(sqlPolicy?.byCategory.TEST_CODE).toBe(1);
      expect(sqlPolicy?.topCategory?.category).toBe("FALSE_POSITIVE");

      const secretPolicy = report.byPolicy.find((p) => p.policyName === "Hardcoded Secret");
      expect(secretPolicy?.totalDismissals).toBe(3);
      expect(secretPolicy?.byCategory.UNSPECIFIED).toBe(1);
    });

    it("database report query integrates properly", async () => {
      (prisma.findingTriage.findMany as any).mockResolvedValueOnce([
        { fingerprint: "fp-1", dismissalReason: "TEST_CODE", dismissedAt: new Date(), repositoryId: "repo-1" },
        { fingerprint: "fp-2", dismissalReason: "WONT_FIX", dismissedAt: new Date(), repositoryId: "repo-1" },
      ]);
      (prisma.finding.findMany as any).mockResolvedValueOnce([
        { fingerprint: "fp-1", type: "Command Injection" },
        { fingerprint: "fp-2", type: "XSS" },
      ]);

      const report = await getDismissalReport({ repositoryId: "repo-1" });
      expect(report.totalDismissals).toBe(2);
      expect(report.byCategory.TEST_CODE).toBe(1);
      expect(report.byCategory.WONT_FIX).toBe(1);
      expect(report.byPolicy).toHaveLength(2);
    });
  });
});
