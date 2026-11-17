import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";
import { GET, resetMetricsCache } from "./route";
import * as landingStatsModule from "@/lib/metrics/landing-stats";

const sampleMetrics = {
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

describe("GET /api/metrics route (#1784)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetMetricsCache();
  });

  it("returns 200 with Prometheus text format by default", async () => {
    vi.spyOn(landingStatsModule, "getDetailedLandingMetrics").mockResolvedValue(sampleMetrics);

    const req = new NextRequest("http://localhost/api/metrics");
    const response = await GET(req);

    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toContain("text/plain");

    const text = await response.text();
    expect(text).toContain("secureflow_scans_total 400");
    expect(text).toContain("secureflow_prs_blocked_total 5");
    expect(text).toContain("secureflow_prs_passed_total 295");
    expect(text).toContain("secureflow_repositories_total 15");
  });

  it("returns 200 with JSON when application/json Accept header is sent", async () => {
    vi.spyOn(landingStatsModule, "getDetailedLandingMetrics").mockResolvedValue(sampleMetrics);

    const req = new NextRequest("http://localhost/api/metrics", {
      headers: { Accept: "application/json" },
    });
    const response = await GET(req);

    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toContain("application/json");

    const json = await response.json();
    expect(json).toEqual(sampleMetrics);
  });

  it("returns 200 with JSON when format=json query parameter is present", async () => {
    vi.spyOn(landingStatsModule, "getDetailedLandingMetrics").mockResolvedValue(sampleMetrics);

    const req = new NextRequest("http://localhost/api/metrics?format=json");
    const response = await GET(req);

    expect(response.status).toBe(200);
    const json = await response.json();
    expect(json.totalScans).toBe(400);
  });

  it("serves subsequent requests from cache", async () => {
    const spy = vi
      .spyOn(landingStatsModule, "getDetailedLandingMetrics")
      .mockResolvedValue(sampleMetrics);

    const first = await GET(new NextRequest("http://localhost/api/metrics"));
    const second = await GET(new NextRequest("http://localhost/api/metrics"));

    expect(spy).toHaveBeenCalledTimes(1);
    expect(first.headers.get("X-Metrics-Cache")).toBe("miss");
    expect(second.headers.get("X-Metrics-Cache")).toBe("hit");
  });

  it("returns 500 when metrics retrieval fails", async () => {
    vi.spyOn(landingStatsModule, "getDetailedLandingMetrics").mockRejectedValue(
      new Error("Database offline"),
    );

    const req = new NextRequest("http://localhost/api/metrics");
    const response = await GET(req);

    expect(response.status).toBe(500);
    const body = await response.json();
    expect(body.error).toBe("Failed to retrieve metrics");
  });
});
