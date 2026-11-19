import { describe, it, expect, beforeEach } from "vitest";
import {
  readCachedRepoHealth,
  writeCachedRepoHealth,
  invalidateCachedRepoHealth,
  clearAllCachedRepoHealth,
  __setClockForTests,
  REPO_HEALTH_CACHE_TTL_MS,
  REPO_HEALTH_CACHE_MAX_ENTRIES,
} from "./health-cache";
import type { RepositoriesOverviewData } from "./types";

describe("health-cache (#1870)", () => {
  let fakeNow = 1_000_000;

  beforeEach(() => {
    fakeNow = 1_000_000;
    __setClockForTests(() => fakeNow);
    clearAllCachedRepoHealth();
  });

  const dummyData: RepositoriesOverviewData = {
    repositories: [
      {
        id: "repo-1",
        fullName: "acme/api",
        owner: "acme",
        hasScans: true,
        lastScanAt: "2026-11-19T10:00:00Z",
        openFindings: { critical: 1, high: 2, medium: 3, low: 0, info: 0, total: 6 },
        blockedPrsLast30Days: 1,
        medianResolveTimeMs: 3600000,
        medianResolveTimeFormatted: "1.0h",
        healthScore: 70,
        healthTier: "NEEDS_ATTENTION",
        trend: [
          { week: 1, weekLabel: "W1", score: 80 },
          { week: 8, weekLabel: "W8", score: 70 },
        ],
      },
    ],
    totalConnected: 1,
    averageHealthScore: 70,
    totalOpenCritical: 1,
    totalOpenHigh: 2,
    totalBlockedPrs30Days: 1,
    cachedAt: fakeNow,
  };

  it("returns null when cache is cold", () => {
    expect(readCachedRepoHealth("user-1")).toBeNull();
  });

  it("stores and retrieves cached data before TTL", () => {
    writeCachedRepoHealth("user-1", dummyData);
    const cached = readCachedRepoHealth("user-1");
    expect(cached).not.toBeNull();
    expect(cached?.repositories[0].fullName).toBe("acme/api");
    expect(cached?.averageHealthScore).toBe(70);
  });

  it("returns defensive deep copies to protect cached state from mutation", () => {
    writeCachedRepoHealth("user-1", dummyData);
    const read1 = readCachedRepoHealth("user-1")!;
    read1.repositories[0].openFindings.critical = 999;
    read1.repositories[0].trend[0].score = 0;

    const read2 = readCachedRepoHealth("user-1")!;
    expect(read2.repositories[0].openFindings.critical).toBe(1);
    expect(read2.repositories[0].trend[0].score).toBe(80);
  });

  it("expires entries after TTL", () => {
    writeCachedRepoHealth("user-1", dummyData);
    fakeNow += REPO_HEALTH_CACHE_TTL_MS + 1;
    expect(readCachedRepoHealth("user-1")).toBeNull();
  });

  it("invalidates cache explicitly", () => {
    writeCachedRepoHealth("user-1", dummyData);
    invalidateCachedRepoHealth("user-1");
    expect(readCachedRepoHealth("user-1")).toBeNull();
  });

  it("evicts oldest entries when reaching max capacity", () => {
    for (let i = 0; i < REPO_HEALTH_CACHE_MAX_ENTRIES + 5; i++) {
      writeCachedRepoHealth(`user-${i}`, dummyData);
    }
    // user-0 through user-4 should have been evicted
    expect(readCachedRepoHealth("user-0")).toBeNull();
    expect(readCachedRepoHealth("user-1")).toBeNull();
    expect(readCachedRepoHealth(`user-${REPO_HEALTH_CACHE_MAX_ENTRIES + 4}`)).not.toBeNull();
  });
});
