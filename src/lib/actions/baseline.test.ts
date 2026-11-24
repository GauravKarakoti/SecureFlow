import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  updateRepositoryBaselineConfig,
  triggerRepositoryBaselineScan,
  getRepositoryBaselineConfig,
  runScheduledBaselineScans,
} from "./baseline";

const { mockAuth, mockPrisma, mockRevalidatePath, mockExecuteBaselineScan } = vi.hoisted(() => ({
  mockAuth: vi.fn(),
  mockPrisma: {
    repository: {
      findFirst: vi.fn(),
      findUnique: vi.fn(),
      findMany: vi.fn(),
      update: vi.fn(),
    },
    auditLog: {
      create: vi.fn(),
    },
  },
  mockRevalidatePath: vi.fn(),
  mockExecuteBaselineScan: vi.fn(),
}));

vi.mock("@/auth", () => ({
  auth: mockAuth,
}));

vi.mock("@/lib/prisma", () => ({
  default: mockPrisma,
}));

vi.mock("next/cache", () => ({
  revalidatePath: mockRevalidatePath,
}));

vi.mock("@/lib/baseline/baseline-scanner", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/baseline/baseline-scanner")>();
  return {
    ...actual,
    executeBaselineScan: mockExecuteBaselineScan,
  };
});

describe("Baseline Actions (#2011)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("updateRepositoryBaselineConfig", () => {
    it("throws unauthorized when session is missing", async () => {
      mockAuth.mockResolvedValue(null);

      await expect(updateRepositoryBaselineConfig("repo-1", { enabled: true })).rejects.toThrow(
        "Unauthorized",
      );
    });

    it("returns error if repository is not found or not owned by user", async () => {
      mockAuth.mockResolvedValue({ user: { id: "user-1" } });
      mockPrisma.repository.findFirst.mockResolvedValue(null);

      const res = await updateRepositoryBaselineConfig("repo-missing", { enabled: true });
      expect(res.ok).toBe(false);
      expect(res.error).toContain("Repository not found");
    });

    it("updates repository baseline configuration and writes audit log", async () => {
      mockAuth.mockResolvedValue({ user: { id: "user-1" } });
      mockPrisma.repository.findFirst.mockResolvedValue({
        id: "repo-1",
        fullName: "acme/repo-1",
        userId: "user-1",
      });
      mockPrisma.repository.update.mockResolvedValue({ id: "repo-1" });
      mockPrisma.auditLog.create.mockResolvedValue({ id: "audit-1" });

      const res = await updateRepositoryBaselineConfig("repo-1", {
        enabled: true,
        frequency: "daily",
        fileLimit: 100,
      });

      expect(res.ok).toBe(true);
      expect(mockPrisma.repository.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: "repo-1" },
          data: expect.objectContaining({
            baselineScanEnabled: true,
            baselineFrequency: "daily",
            baselineFileLimit: 100,
          }),
        }),
      );

      expect(mockPrisma.auditLog.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            userId: "user-1",
            action: "REPOSITORY_BASELINE_CONFIG_UPDATE",
            resource: "repository:acme/repo-1",
          }),
        }),
      );

      expect(mockRevalidatePath).toHaveBeenCalledWith("/dashboard/settings");
      expect(mockRevalidatePath).toHaveBeenCalledWith("/dashboard/findings");
    });
  });

  describe("triggerRepositoryBaselineScan", () => {
    it("throws unauthorized when session is missing", async () => {
      mockAuth.mockResolvedValue(null);

      await expect(triggerRepositoryBaselineScan("repo-1")).rejects.toThrow("Unauthorized");
    });

    it("executes baseline scan when forced", async () => {
      mockAuth.mockResolvedValue({ user: { id: "user-1" } });
      mockPrisma.repository.findFirst.mockResolvedValue({
        id: "repo-1",
        fullName: "acme/repo-1",
        userId: "user-1",
        baselineScanEnabled: true,
      });

      mockExecuteBaselineScan.mockResolvedValue({
        scanResultId: "scan-123",
        scannedFiles: 10,
        findingsFound: 2,
      });

      const res = await triggerRepositoryBaselineScan("repo-1", { force: true });
      expect(res.ok).toBe(true);
      expect(res.scanResultId).toBe("scan-123");
      expect(mockExecuteBaselineScan).toHaveBeenCalledWith(
        expect.objectContaining({
          repositoryId: "repo-1",
          repositoryFullName: "acme/repo-1",
          force: true,
        }),
      );
    });
  });

  describe("getRepositoryBaselineConfig", () => {
    it("returns repository baseline configuration with isDue check", async () => {
      mockAuth.mockResolvedValue({ user: { id: "user-1" } });
      mockPrisma.repository.findFirst.mockResolvedValue({
        id: "repo-1",
        fullName: "acme/repo-1",
        baselineScanEnabled: true,
        baselineFrequency: "weekly",
        baselineFileLimit: 50,
        lastBaselineScanAt: null,
        lastBaselineScanStatus: null,
      });

      const config = await getRepositoryBaselineConfig("repo-1");
      expect(config).toBeDefined();
      expect(config?.baselineScanEnabled).toBe(true);
      expect(config?.isDue).toBe(true);
    });
  });

  describe("runScheduledBaselineScans", () => {
    it("dispatches due baseline scans across enabled repositories", async () => {
      mockPrisma.repository.findMany.mockResolvedValue([
        {
          id: "repo-due",
          fullName: "acme/due",
          baselineScanEnabled: true,
          baselineFrequency: "weekly",
          baselineFileLimit: 50,
          lastBaselineScanAt: null, // Due
        },
        {
          id: "repo-not-due",
          fullName: "acme/not-due",
          baselineScanEnabled: true,
          baselineFrequency: "weekly",
          baselineFileLimit: 50,
          lastBaselineScanAt: new Date(), // Not due
        },
      ]);

      mockExecuteBaselineScan.mockResolvedValue({
        scanResultId: "scan-ok",
      });

      const res = await runScheduledBaselineScans();
      expect(res.dispatched).toBe(1);
      expect(mockExecuteBaselineScan).toHaveBeenCalledTimes(1);
      expect(mockExecuteBaselineScan).toHaveBeenCalledWith(
        expect.objectContaining({
          repositoryId: "repo-due",
          repositoryFullName: "acme/due",
        }),
      );
    });
  });
});
