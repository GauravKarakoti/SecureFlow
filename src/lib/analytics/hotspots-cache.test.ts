import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  readCachedHotspots,
  writeCachedHotspots,
  invalidateCachedHotspots,
  clearAllCachedHotspots,
  __setHotspotsClockForTests,
  HOTSPOTS_CACHE_TTL_MS,
  HOTSPOTS_CACHE_MAX_ENTRIES,
} from "./hotspots-cache";
import type { RepoHotspotGroup } from "./hotspots";

const sampleData: RepoHotspotGroup[] = [
  {
    repositoryId: "repo-1",
    repositoryFullName: "owner/repo-1",
    totalOpenFindings: 3,
    hotspotsByDepth: {
      1: [
        {
          directory: "src",
          pathPrefix: "src/",
          openCount: 3,
          severityCounts: { CRITICAL: 1, HIGH: 2, MEDIUM: 0, LOW: 0, INFO: 0 },
          trend: { direction: "up", change: 2, percentage: 200 },
        },
      ],
    },
  },
];

describe("hotspots-cache", () => {
  beforeEach(() => {
    clearAllCachedHotspots();
    __setHotspotsClockForTests();
  });

  it("returns null on cache miss", () => {
    expect(readCachedHotspots("user-1")).toBeNull();
  });

  it("caches and retrieves data within TTL", () => {
    let now = 1000;
    __setHotspotsClockForTests(() => now);

    writeCachedHotspots("user-1", sampleData);
    const cached = readCachedHotspots("user-1");
    expect(cached).toEqual(sampleData);

    // Advance clock within TTL
    now += HOTSPOTS_CACHE_TTL_MS - 1000;
    expect(readCachedHotspots("user-1")).toEqual(sampleData);
  });

  it("expires entries after TTL", () => {
    let now = 1000;
    __setHotspotsClockForTests(() => now);

    writeCachedHotspots("user-1", sampleData);

    // Advance clock past TTL
    now += HOTSPOTS_CACHE_TTL_MS + 1;
    expect(readCachedHotspots("user-1")).toBeNull();
  });

  it("supports manual invalidation", () => {
    writeCachedHotspots("user-1", sampleData);
    expect(readCachedHotspots("user-1")).not.toBeNull();

    invalidateCachedHotspots("user-1");
    expect(readCachedHotspots("user-1")).toBeNull();
  });

  it("evicts oldest entry when reaching max capacity", () => {
    for (let i = 0; i < HOTSPOTS_CACHE_MAX_ENTRIES + 5; i++) {
      writeCachedHotspots(`user-${i}`, sampleData);
    }

    // The first 5 should be evicted
    for (let i = 0; i < 5; i++) {
      expect(readCachedHotspots(`user-${i}`)).toBeNull();
    }
    // The latest should remain
    expect(readCachedHotspots(`user-${HOTSPOTS_CACHE_MAX_ENTRIES}`)).not.toBeNull();
  });
});
