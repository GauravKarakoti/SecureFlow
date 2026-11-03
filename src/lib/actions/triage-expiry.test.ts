import { describe, it, expect, vi, beforeEach } from "vitest";

const {
  mockFindingTriageFindMany,
  mockRepositoryFindFirst,
  mockRepositoryFindMany,
  mockAuditLogCreate,
  mockUpsert,
} = vi.hoisted(() => ({
  mockFindingTriageFindMany: vi.fn(),
  mockRepositoryFindFirst: vi.fn(),
  mockRepositoryFindMany: vi.fn(),
  mockAuditLogCreate: vi.fn(),
  mockUpsert: vi.fn(),
}));

vi.mock("@/auth", () => ({
  auth: vi.fn().mockResolvedValue({ user: { id: "user-123" } }),
}));

vi.mock("@/lib/prisma", () => ({
  default: {
    findingTriage: {
      findMany: mockFindingTriageFindMany,
      upsert: mockUpsert,
    },
    repository: {
      findFirst: mockRepositoryFindFirst,
      findMany: mockRepositoryFindMany,
    },
    auditLog: {
      create: mockAuditLogCreate,
    },
    $transaction: vi.fn(async (callback: (tx: any) => Promise<unknown>) => {
      return await callback({
        findingTriage: { upsert: mockUpsert },
        auditLog: { create: mockAuditLogCreate },
      });
    }),
  },
}));

vi.mock("next/cache", () => ({
  revalidatePath: vi.fn(),
}));

vi.mock("@/lib/audit/user-filter-cache", () => ({
  invalidateCachedUserFilters: vi.fn(),
}));

import { setFindingStatus, setFindingStatuses } from "./triage";
import { getSuppressedFingerprints, getUserTriage } from "@/lib/triage/queries";

describe("Triage Expiry Enforcement Integration (#1503)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("setFindingStatus with optional expiry", () => {
    it("sets expiry for FALSE_POSITIVE with a valid future date", async () => {
      mockRepositoryFindFirst.mockResolvedValue({ id: "repo-1", fullName: "owner/repo" });
      const futureDate = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);

      const res = await setFindingStatus({
        repositoryId: "repo-1",
        fingerprint: "fp-critical-1",
        status: "FALSE_POSITIVE",
        note: "Accepted temporary risk",
        expiresAt: futureDate,
      });

      expect(res.ok).toBe(true);
      expect(mockUpsert).toHaveBeenCalledWith(
        expect.objectContaining({
          update: expect.objectContaining({
            status: "FALSE_POSITIVE",
            expiresAt: futureDate,
          }),
        }),
      );
    });

    it("rejects an expiry date in the past with a clear error", async () => {
      mockRepositoryFindFirst.mockResolvedValue({ id: "repo-1", fullName: "owner/repo" });
      const pastDate = new Date(Date.now() - 24 * 60 * 60 * 1000);

      const res = await setFindingStatus({
        repositoryId: "repo-1",
        fingerprint: "fp-critical-1",
        status: "FALSE_POSITIVE",
        expiresAt: pastDate,
      });

      expect(res.ok).toBe(false);
      expect(res.error).toBe("Expiry date must be in the future");
      expect(mockUpsert).not.toHaveBeenCalled();
    });

    it("ignores expiry and clears it when setting status to OPEN or RESOLVED", async () => {
      mockRepositoryFindFirst.mockResolvedValue({ id: "repo-1", fullName: "owner/repo" });
      const futureDate = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);

      const res = await setFindingStatus({
        repositoryId: "repo-1",
        fingerprint: "fp-critical-1",
        status: "RESOLVED",
        expiresAt: futureDate,
      });

      expect(res.ok).toBe(true);
      expect(mockUpsert).toHaveBeenCalledWith(
        expect.objectContaining({
          update: expect.objectContaining({
            status: "RESOLVED",
            expiresAt: null,
          }),
        }),
      );
    });

    it("re-dismissing without an expiry clears any previously set expiry", async () => {
      mockRepositoryFindFirst.mockResolvedValue({ id: "repo-1", fullName: "owner/repo" });

      const res = await setFindingStatus({
        repositoryId: "repo-1",
        fingerprint: "fp-critical-1",
        status: "IGNORED",
        expiresAt: null,
      });

      expect(res.ok).toBe(true);
      expect(mockUpsert).toHaveBeenCalledWith(
        expect.objectContaining({
          update: expect.objectContaining({
            status: "IGNORED",
            expiresAt: null,
          }),
        }),
      );
    });
  });

  describe("setFindingStatuses bulk triage with expiry", () => {
    it("applies expiry across all selected findings in transaction", async () => {
      mockRepositoryFindMany.mockResolvedValue([{ id: "repo-1", fullName: "owner/repo" }]);
      const futureDate = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);

      const res = await setFindingStatuses({
        items: [
          { repositoryId: "repo-1", fingerprint: "fp-1" },
          { repositoryId: "repo-1", fingerprint: "fp-2" },
        ],
        status: "IGNORED",
        expiresAt: futureDate,
      });

      expect(res.ok).toBe(true);
      expect(mockUpsert).toHaveBeenCalledTimes(2);
      expect(mockUpsert).toHaveBeenCalledWith(
        expect.objectContaining({
          update: expect.objectContaining({
            status: "IGNORED",
            expiresAt: futureDate,
          }),
        }),
      );
    });

    it("fails as a whole without persisting if expiry validation fails", async () => {
      mockRepositoryFindMany.mockResolvedValue([{ id: "repo-1", fullName: "owner/repo" }]);
      const pastDate = new Date(Date.now() - 1000);

      const res = await setFindingStatuses({
        items: [
          { repositoryId: "repo-1", fingerprint: "fp-1" },
          { repositoryId: "repo-1", fingerprint: "fp-2" },
        ],
        status: "IGNORED",
        expiresAt: pastDate,
      });

      expect(res.ok).toBe(false);
      expect(res.error).toBe("Expiry date must be in the future");
      expect(mockUpsert).not.toHaveBeenCalled();
    });
  });

  describe("getSuppressedFingerprints and getUserTriage expiry filtering", () => {
    it("queries database using active suppression where fragment", async () => {
      mockFindingTriageFindMany.mockResolvedValue([
        { fingerprint: "fp-active-1" },
        { fingerprint: "fp-active-2" },
      ]);

      const result = await getSuppressedFingerprints("user-123");
      expect(result.fingerprints).toEqual(["fp-active-1", "fp-active-2"]);
      expect(result.has("fp-active-1")).toBe(true);
      expect(result.has("fp-unknown")).toBe(false);

      expect(mockFindingTriageFindMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            repository: { userId: "user-123" },
            status: { in: ["FALSE_POSITIVE", "IGNORED", "DISMISSED"] },
            OR: [{ expiresAt: null }, { expiresAt: expect.any(Object) }],
          }),
        }),
      );
    });

    it("getUserTriage separates expired from actively suppressed findings", async () => {
      const now = Date.now();
      mockFindingTriageFindMany.mockResolvedValue([
        {
          repositoryId: "repo-1",
          fingerprint: "fp-valid",
          status: "FALSE_POSITIVE",
          note: "Active dismissal",
          expiresAt: new Date(now + 100_000),
        },
        {
          repositoryId: "repo-1",
          fingerprint: "fp-expired",
          status: "IGNORED",
          note: "Expired dismissal",
          expiresAt: new Date(now - 100_000),
        },
      ]);

      const triage = await getUserTriage("user-123");
      // Only unexpired should be in suppressedFingerprints
      expect(triage.suppressedFingerprints).toContain("fp-valid");
      expect(triage.suppressedFingerprints).not.toContain("fp-expired");

      // Both should remain in byKey for UI display
      expect(triage.byKey.has("repo-1:fp-valid")).toBe(true);
      expect(triage.byKey.has("repo-1:fp-expired")).toBe(true);
    });
  });
});
