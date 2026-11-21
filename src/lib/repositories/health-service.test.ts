import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  calculateMedian,
  formatResolutionDuration,
  fetchRepositoryHealthData,
} from "./health-service";
import { clearAllCachedRepoHealth } from "./health-cache";

// Mock prisma
vi.mock("@/lib/prisma", () => ({
  default: {
    repository: {
      findMany: vi.fn(),
    },
    findingTriage: {
      findMany: vi.fn(),
    },
    pullRequest: {
      groupBy: vi.fn(),
    },
    scanResult: {
      findMany: vi.fn(),
    },
    finding: {
      findMany: vi.fn(),
    },
  },
}));

import prisma from "@/lib/prisma";

describe("health-service (#1870)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    clearAllCachedRepoHealth();
  });

  describe("calculateMedian", () => {
    it("returns null for empty array", () => {
      expect(calculateMedian([])).toBeNull();
    });

    it("returns the middle element for odd length arrays", () => {
      expect(calculateMedian([500])).toBe(500);
      expect(calculateMedian([300, 100, 200])).toBe(200);
      expect(calculateMedian([10, 40, 20, 50, 30])).toBe(30);
    });

    it("returns the average of the two middle elements for even length arrays", () => {
      expect(calculateMedian([100, 200])).toBe(150);
      expect(calculateMedian([10, 30, 20, 40])).toBe(25);
    });
  });

  describe("formatResolutionDuration", () => {
    it("returns dash for null or negative durations", () => {
      expect(formatResolutionDuration(null)).toBe("—");
      expect(formatResolutionDuration(-500)).toBe("—");
    });

    it("formats minutes for durations under an hour", () => {
      expect(formatResolutionDuration(60 * 1000)).toBe("1m");
      expect(formatResolutionDuration(45 * 60 * 1000)).toBe("45m");
    });

    it("formats hours for durations under 24 hours", () => {
      expect(formatResolutionDuration(2.5 * 60 * 60 * 1000)).toBe("2.5h");
      expect(formatResolutionDuration(12 * 60 * 60 * 1000)).toBe("12.0h");
    });

    it("formats days for durations of 24 hours or more", () => {
      expect(formatResolutionDuration(24 * 60 * 60 * 1000)).toBe("1.0d");
      expect(formatResolutionDuration(3.5 * 24 * 60 * 60 * 1000)).toBe("3.5d");
    });
  });

  describe("fetchRepositoryHealthData", () => {
    it("returns empty structure when user has no active repositories", async () => {
      (prisma.repository.findMany as any).mockResolvedValueOnce([]);

      const result = await fetchRepositoryHealthData("user-empty");
      expect(result.repositories).toEqual([]);
      expect(result.totalConnected).toBe(0);
      expect(result.averageHealthScore).toBeNull();
    });

    it("returns unranked repository summary when repo has no scans", async () => {
      (prisma.repository.findMany as any).mockResolvedValueOnce([
        {
          id: "repo-no-scans",
          fullName: "org/unscanned",
          owner: "org",
          createdAt: new Date("2026-01-01"),
        },
      ]);
      (prisma.findingTriage.findMany as any).mockResolvedValueOnce([]);
      (prisma.pullRequest.groupBy as any).mockResolvedValueOnce([]);
      (prisma.scanResult.findMany as any).mockResolvedValueOnce([]);
      (prisma.finding.findMany as any).mockResolvedValueOnce([]);

      const result = await fetchRepositoryHealthData("user-1");
      expect(result.repositories).toHaveLength(1);
      const repo = result.repositories[0];
      expect(repo.hasScans).toBe(false);
      expect(repo.healthScore).toBeNull();
      expect(repo.healthTier).toBe("UNRANKED");
      expect(repo.medianResolveTimeFormatted).toBe("—");
      expect(repo.trend).toHaveLength(8);
      expect(repo.trend[0].score).toBeNull();
    });

    it("aggregates findings, blocked PRs, and resolved triage to compute score and trend", async () => {
      const now = new Date();
      (prisma.repository.findMany as any).mockResolvedValueOnce([
        {
          id: "repo-active",
          fullName: "org/active-service",
          owner: "org",
          createdAt: new Date("2026-01-01"),
        },
      ]);

      // 1 resolved triage (3 hours), 1 dismissed triage
      (prisma.findingTriage.findMany as any).mockResolvedValueOnce([
        {
          repositoryId: "repo-active",
          fingerprint: "resolved-fp",
          status: "RESOLVED",
          createdAt: new Date(now.getTime() - 4 * 3600 * 1000),
          resolvedAt: new Date(now.getTime() - 1 * 3600 * 1000), // 3 hours
          updatedAt: new Date(now.getTime() - 1 * 3600 * 1000),
        },
        {
          repositoryId: "repo-active",
          fingerprint: "dismissed-fp",
          status: "FALSE_POSITIVE",
          createdAt: new Date(now.getTime() - 10 * 3600 * 1000),
          resolvedAt: null,
          updatedAt: new Date(now.getTime() - 10 * 3600 * 1000),
        },
      ]);

      // 1 blocked PR in last 30d
      (prisma.pullRequest.groupBy as any).mockResolvedValueOnce([
        {
          repositoryId: "repo-active",
          _count: { _all: 1 },
        },
      ]);

      // Scans exist
      (prisma.scanResult.findMany as any).mockResolvedValueOnce([
        {
          id: "scan-1",
          createdAt: now,
          pullRequest: { repositoryId: "repo-active" },
        },
      ]);

      // Findings:
      // 1 CRITICAL open
      // 1 HIGH open (repeated twice with same fingerprint -> should deduplicate to 1)
      // 1 CRITICAL that is resolved-fp -> should be excluded from open
      // 1 MEDIUM that is dismissed-fp -> should be excluded from open
      (prisma.finding.findMany as any).mockResolvedValueOnce([
        {
          severity: "CRITICAL",
          fingerprint: "crit-open-1",
          createdAt: now,
          scanResult: { pullRequest: { repositoryId: "repo-active" } },
        },
        {
          severity: "HIGH",
          fingerprint: "high-open-1",
          createdAt: now,
          scanResult: { pullRequest: { repositoryId: "repo-active" } },
        },
        {
          severity: "HIGH",
          fingerprint: "high-open-1", // duplicate fingerprint from re-scan
          createdAt: now,
          scanResult: { pullRequest: { repositoryId: "repo-active" } },
        },
        {
          severity: "CRITICAL",
          fingerprint: "resolved-fp", // resolved -> excluded
          createdAt: now,
          scanResult: { pullRequest: { repositoryId: "repo-active" } },
        },
        {
          severity: "MEDIUM",
          fingerprint: "dismissed-fp", // dismissed -> excluded
          createdAt: now,
          scanResult: { pullRequest: { repositoryId: "repo-active" } },
        },
      ]);

      const result = await fetchRepositoryHealthData("user-active");
      expect(result.repositories).toHaveLength(1);
      const repo = result.repositories[0];

      expect(repo.hasScans).toBe(true);
      expect(repo.openFindings.critical).toBe(1);
      expect(repo.openFindings.high).toBe(1);
      expect(repo.openFindings.medium).toBe(0);
      expect(repo.openFindings.total).toBe(2);
      expect(repo.blockedPrsLast30Days).toBe(1);
      expect(repo.medianResolveTimeFormatted).toBe("3.0h");

      // Score: 100 - (15 crit + 8 high = 23) - (5 blocked PR) - (0 resolve penalty for 3h) = 72
      expect(repo.healthScore).toBe(72);
      expect(repo.healthTier).toBe("NEEDS_ATTENTION");

      // Serves next call from cache without querying database
      const cachedResult = await fetchRepositoryHealthData("user-active");
      expect(cachedResult.repositories[0].healthScore).toBe(72);
      expect(prisma.repository.findMany).toHaveBeenCalledTimes(1);
    });
  });
});
