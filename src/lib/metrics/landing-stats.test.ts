import { describe, it, expect, vi, beforeEach } from "vitest";
import prisma from "@/lib/prisma";
import {
  getLandingStats,
  getDetailedLandingMetrics,
  readLandingCounts,
  toLandingStats,
  ADVERTISED_SCAN_AVERAGE_SECONDS,
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

describe("landing-stats honesty (#705)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("the removed fresh-install branch", () => {
    it("reports a genuinely empty install as zeros, not as invented numbers", async () => {
      vi.mocked(prisma.pullRequest.count).mockResolvedValue(0);
      vi.mocked(prisma.finding.count).mockResolvedValue(0);
      vi.mocked(prisma.repository.count).mockResolvedValue(0);
      vi.mocked(prisma.scanResult.count).mockResolvedValue(0);

      const stats = await getLandingStats();

      // The old code had a branch here whose comment promised "baseline values
      // for display" and whose overrides were all `dbCount ?? baseline` — and
      // `0 ?? x` is `0`, so it returned zeros regardless. What it did carry
      // over was the baseline scanAverage, next to `isLive: true`. An empty
      // install has no pull requests; saying so is the correct answer.
      expect(stats.prsCount).toBe(0);
      expect(stats.secretsCount).toBe(0);
      expect(stats.reposCount).toBe(0);
      expect(stats.isLive).toBe(true);
      expect(stats).not.toMatchObject({ prsCount: BASELINE_FALLBACK_METRICS.prsCount });
    });
  });

  describe("isLive", () => {
    it("is false when the ScanResult count fails, which it used to ignore", async () => {
      // isLive was computed from three of the four counts, so a failed
      // ScanResult query left the response claiming to be live.
      vi.mocked(prisma.pullRequest.count).mockResolvedValue(10);
      vi.mocked(prisma.finding.count).mockResolvedValue(2);
      vi.mocked(prisma.repository.count).mockResolvedValue(1);
      vi.mocked(prisma.scanResult.count).mockRejectedValue(new Error("scan table locked"));

      expect((await getLandingStats()).isLive).toBe(false);
    });

    it("is never true alongside a substituted baseline value", () => {
      // The invariant worth pinning: any fabricated field means not live.
      const cases = [
        { prs: null, secrets: 1, repos: 1, scans: 1 },
        { prs: 1, secrets: null, repos: 1, scans: 1 },
        { prs: 1, secrets: 1, repos: null, scans: 1 },
        { prs: 1, secrets: 1, repos: 1, scans: null },
      ];

      for (const counts of cases) {
        expect(toLandingStats(counts).isLive).toBe(false);
      }

      expect(toLandingStats({ prs: 1, secrets: 1, repos: 1, scans: 1 }).isLive).toBe(true);
    });
  });

  describe("scanAverage", () => {
    it("is the named advertised constant rather than a bare literal", async () => {
      vi.mocked(prisma.pullRequest.count).mockResolvedValue(120);
      vi.mocked(prisma.finding.count).mockResolvedValue(45);
      vi.mocked(prisma.repository.count).mockResolvedValue(18);
      vi.mocked(prisma.scanResult.count).mockResolvedValue(200);

      // Not a measurement, and the constant's name says so: nothing in the
      // schema records how long a scan took, so there is nothing to average.
      expect((await getLandingStats()).scanAverage).toBe(ADVERTISED_SCAN_AVERAGE_SECONDS);
    });
  });

  describe("readLandingCounts", () => {
    it("degrades one failing count to null without taking the others down", async () => {
      vi.mocked(prisma.pullRequest.count).mockResolvedValue(7);
      vi.mocked(prisma.finding.count).mockRejectedValue(new Error("nope"));
      vi.mocked(prisma.repository.count).mockResolvedValue(3);
      vi.mocked(prisma.scanResult.count).mockResolvedValue(11);

      expect(await readLandingCounts()).toEqual({ prs: 7, secrets: null, repos: 3, scans: 11 });
    });
  });

  describe("getDetailedLandingMetrics", () => {
    it("counts ScanResult once, not twice, and actually uses the answer", async () => {
      vi.mocked(prisma.pullRequest.count).mockResolvedValue(50);
      vi.mocked(prisma.finding.count).mockResolvedValue(5);
      vi.mocked(prisma.repository.count).mockResolvedValue(2);
      vi.mocked(prisma.scanResult.count).mockResolvedValue(64);

      const detailed = await getDetailedLandingMetrics();

      // It used to call getLandingStats — which counts ScanResult, then throws
      // the number away — and then count ScanResult again in its own batch.
      expect(prisma.scanResult.count).toHaveBeenCalledTimes(1);
      expect(detailed.totalScans).toBe(64);
    });

    it("reports zero scans rather than a fabricated figure when that count failed", async () => {
      vi.mocked(prisma.pullRequest.count).mockResolvedValue(50);
      vi.mocked(prisma.finding.count).mockResolvedValue(5);
      vi.mocked(prisma.repository.count).mockResolvedValue(2);
      vi.mocked(prisma.scanResult.count).mockRejectedValue(new Error("nope"));

      const detailed = await getDetailedLandingMetrics();

      expect(detailed.totalScans).toBe(0);
      expect(detailed.isLive).toBe(false);
    });
  });
});
