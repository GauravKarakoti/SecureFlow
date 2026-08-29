import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";
import { GET, METRICS_CACHE_SECONDS, resetLandingMetricsCache } from "./route";
import * as landingStatsModule from "@/lib/metrics/landing-stats";

const request = () => new NextRequest("http://localhost/api/metrics/landing");

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

describe("GET /api/metrics/landing route (#632, #705)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // The cache is process-wide, so it has to be dropped between cases or the
    // first case's value would be served to all the others.
    resetLandingMetricsCache();
  });

  it("returns 200 with calculated landing metrics", async () => {
    vi.spyOn(landingStatsModule, "getDetailedLandingMetrics").mockResolvedValue(mockMetrics);

    const response = await GET(request());
    expect(response.status).toBe(200);

    const data = await response.json();
    expect(data).toEqual(mockMetrics);
    expect(response.headers.get("Cache-Control")).toContain("public");
    expect(response.headers.get("Cache-Control")).toContain(`s-maxage=${METRICS_CACHE_SECONDS}`);
  });

  it("returns 500 when metrics retrieval throws an unexpected error", async () => {
    vi.spyOn(landingStatsModule, "getDetailedLandingMetrics").mockRejectedValue(
      new Error("Fatal Redis/DB connection drop")
    );

    const response = await GET(request());
    expect(response.status).toBe(500);

    const data = await response.json();
    expect(data.error).toBe("Failed to retrieve security metrics");
  });

  it("serves a second request from cache instead of re-running the aggregates", async () => {
    // The endpoint is public, unauthenticated and force-dynamic, and every miss
    // fans out into COUNT(*) over the four largest tables in the schema.
    const spy = vi
      .spyOn(landingStatsModule, "getDetailedLandingMetrics")
      .mockResolvedValue(mockMetrics);

    const first = await GET(request());
    const second = await GET(request());

    expect(spy).toHaveBeenCalledTimes(1);
    expect(first.headers.get("X-Metrics-Cache")).toBe("miss");
    expect(second.headers.get("X-Metrics-Cache")).toBe("hit");
    expect(await second.json()).toEqual(mockMetrics);
  });

  it("collapses concurrent misses onto one query", async () => {
    // A plain TTL cache with no single-flight is at its most useless exactly
    // when it matters: the instant the entry expires under load, every
    // concurrent request misses together and they all query at once.
    const spy = vi
      .spyOn(landingStatsModule, "getDetailedLandingMetrics")
      .mockImplementation(
        () => new Promise((resolve) => setTimeout(() => resolve(mockMetrics), 10))
      );

    const responses = await Promise.all([GET(request()), GET(request()), GET(request())]);

    expect(spy).toHaveBeenCalledTimes(1);
    for (const response of responses) {
      expect(response.status).toBe(200);
    }
  });

  it("does not cache a failure, so a transient outage is not served for a whole window", async () => {
    const spy = vi.spyOn(landingStatsModule, "getDetailedLandingMetrics");

    spy.mockRejectedValueOnce(new Error("connection reset"));
    expect((await GET(request())).status).toBe(500);

    spy.mockResolvedValueOnce(mockMetrics);
    const recovered = await GET(request());

    expect(recovered.status).toBe(200);
    expect(await recovered.json()).toEqual(mockMetrics);
    expect(spy).toHaveBeenCalledTimes(2);
  });

  it("is rate limited, unlike every previous version of this route", async () => {
    vi.spyOn(landingStatsModule, "getDetailedLandingMetrics").mockResolvedValue(mockMetrics);

    const response = await GET(request());

    // withRateLimit attaches these on every allowed response. Their presence is
    // what says the wrapper is actually in the chain — this was the only route
    // under src/app/api exporting a bare GET with no wrapper at all.
    expect(response.headers.get("X-RateLimit-Limit")).toBeTruthy();
    expect(response.headers.get("X-RateLimit-Remaining")).toBeTruthy();
  });
});
