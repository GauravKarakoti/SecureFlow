import { describe, it, expect, vi, beforeEach } from "vitest";
import { GET } from "./route";
import * as landingStatsModule from "@/lib/metrics/landing-stats";

describe("GET /api/metrics/landing route (#632)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns 200 with calculated landing metrics", async () => {
    const mockMetrics = {
      prsCount: 300,
      secretsCount: 42,
      reposCount: 15,
      scanAverage: 1.4,
      isLive: true,
      totalScans: 400,
      totalVulnerabilities: 20,
      totalMisconfigs: 10,
      blockedPRs: 5,
      passedPRs: 295,
    };

    vi.spyOn(landingStatsModule, "getDetailedLandingMetrics").mockResolvedValue(mockMetrics);

    const response = await GET();
    expect(response.status).toBe(200);

    const data = await response.json();
    expect(data).toEqual(mockMetrics);
    expect(response.headers.get("Cache-Control")).toContain("public");
  });

  it("returns 500 when metrics retrieval throws an unexpected error", async () => {
    vi.spyOn(landingStatsModule, "getDetailedLandingMetrics").mockRejectedValue(
      new Error("Fatal Redis/DB connection drop")
    );

    const response = await GET();
    expect(response.status).toBe(500);

    const data = await response.json();
    expect(data.error).toBe("Failed to retrieve security metrics");
  });
});
