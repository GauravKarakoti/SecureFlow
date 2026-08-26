import { describe, it, expect, vi, beforeEach } from "vitest";
import prisma from "@/lib/prisma";
import {
  getLandingStats,
  getDetailedLandingMetrics,
  BASELINE_FALLBACK_METRICS,
} from "./landing-stats";

vi.mock("@/lib/prisma", () => {
  return {
    default: {
      pullRequest: {
        count: vi.fn(),
      },
      finding: {
        count: vi.fn(),
      },
      repository: {
        count: vi.fn(),
      },
      scanResult: {
        count: vi.fn(),
      },
    },
  };
});

describe("landing-stats module (#632)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("getLandingStats", () => {
    it("returns real database metrics when counts are available", async () => {
      vi.mocked(prisma.pullRequest.count).mockResolvedValue(120);
      vi.mocked(prisma.finding.count).mockResolvedValue(45);
      vi.mocked(prisma.repository.count).mockResolvedValue(18);
      vi.mocked(prisma.scanResult.count).mockResolvedValue(200);

      const stats = await getLandingStats();

      expect(stats).toEqual({
        prsCount: 120,
        secretsCount: 45,
        reposCount: 18,
        scanAverage: 1.4,
        isLive: true,
      });

      expect(prisma.finding.count).toHaveBeenCalledWith({
        where: {
          type: "SECRET",
        },
      });
      expect(prisma.repository.count).toHaveBeenCalledWith({
        where: {
          isActive: true,
        },
      });
    });

    it("handles database count errors gracefully and provides baseline fallbacks", async () => {
      vi.mocked(prisma.pullRequest.count).mockRejectedValue(new Error("DB connection timeout"));
      vi.mocked(prisma.finding.count).mockRejectedValue(new Error("Finding table error"));
      vi.mocked(prisma.repository.count).mockRejectedValue(new Error("Repository table error"));
      vi.mocked(prisma.scanResult.count).mockRejectedValue(new Error("ScanResult table error"));

      const stats = await getLandingStats();

      expect(stats.prsCount).toBe(BASELINE_FALLBACK_METRICS.prsCount);
      expect(stats.secretsCount).toBe(BASELINE_FALLBACK_METRICS.secretsCount);
      expect(stats.reposCount).toBe(BASELINE_FALLBACK_METRICS.reposCount);
      expect(stats.isLive).toBe(false);
    });

    it("returns real 0 counts when DB is empty and initialized", async () => {
      vi.mocked(prisma.pullRequest.count).mockResolvedValue(0);
      vi.mocked(prisma.finding.count).mockResolvedValue(0);
      vi.mocked(prisma.repository.count).mockResolvedValue(0);
      vi.mocked(prisma.scanResult.count).mockResolvedValue(0);

      const stats = await getLandingStats();

      expect(stats.prsCount).toBe(0);
      expect(stats.secretsCount).toBe(0);
      expect(stats.reposCount).toBe(0);
      expect(stats.isLive).toBe(true);
    });

    it("handles partial failure where some queries succeed and others reject", async () => {
      vi.mocked(prisma.pullRequest.count).mockResolvedValue(55);
      vi.mocked(prisma.finding.count).mockRejectedValue(new Error("Finding error"));
      vi.mocked(prisma.repository.count).mockResolvedValue(12);
      vi.mocked(prisma.scanResult.count).mockResolvedValue(60);

      const stats = await getLandingStats();

      expect(stats.prsCount).toBe(55);
      expect(stats.secretsCount).toBe(BASELINE_FALLBACK_METRICS.secretsCount);
      expect(stats.reposCount).toBe(12);
      expect(stats.isLive).toBe(false);
    });
  });

  describe("getDetailedLandingMetrics", () => {
    it("returns complete detailed security breakdown", async () => {
      vi.mocked(prisma.pullRequest.count)
        .mockResolvedValueOnce(50) // total PRs
        .mockResolvedValueOnce(10) // blocked PRs
        .mockResolvedValueOnce(40); // passed PRs
      vi.mocked(prisma.finding.count)
        .mockResolvedValueOnce(15) // SECRET
        .mockResolvedValueOnce(8) // VULNERABILITY
        .mockResolvedValueOnce(4); // MISCONFIG
      vi.mocked(prisma.repository.count).mockResolvedValue(5);
      vi.mocked(prisma.scanResult.count).mockResolvedValueOnce(50).mockResolvedValueOnce(50);

      const detailed = await getDetailedLandingMetrics();

      expect(detailed.prsCount).toBe(50);
      expect(detailed.secretsCount).toBe(15);
      expect(detailed.totalVulnerabilities).toBe(8);
      expect(detailed.totalMisconfigs).toBe(4);
      expect(detailed.blockedPRs).toBe(10);
      expect(detailed.passedPRs).toBe(40);
    });

    it("handles partial failures during detailed metrics collection", async () => {
      vi.mocked(prisma.pullRequest.count).mockResolvedValue(20);
      vi.mocked(prisma.finding.count).mockRejectedValue(new Error("Table locked"));
      vi.mocked(prisma.repository.count).mockResolvedValue(3);
      vi.mocked(prisma.scanResult.count).mockResolvedValue(20);

      const detailed = await getDetailedLandingMetrics();

      expect(detailed.prsCount).toBe(20);
      expect(detailed.totalVulnerabilities).toBe(0);
      expect(detailed.totalMisconfigs).toBe(0);
    });
  });
});
