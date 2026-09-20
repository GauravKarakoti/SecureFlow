import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const prismaMock = vi.hoisted(() => ({
  scanResult: { findMany: vi.fn(), count: vi.fn(), aggregate: vi.fn() },
  finding: { findMany: vi.fn(), groupBy: vi.fn(), count: vi.fn() },
  repository: { findMany: vi.fn() },
  pullRequest: { count: vi.fn() },
}));

vi.mock("@/lib/prisma", () => ({ default: prismaMock }));

import {
  fetchAnalyticsSummary,
  fetchDailyScanMetrics,
  fetchRepoSummaries,
  fetchScanVelocity,
  fetchSeverityTrend,
  fetchTopFindingTypes,
  formatDateLabel,
  generateDateRange,
  getAnalyticsPayload,
  utcRangeBounds,
} from "./scan-history";

// 08:30 in India on 19 Sep, 03:00 UTC: the UTC date and the local date agree,
// but local midnight is 18:30 UTC on the 18th.
const NOW = new Date("2026-09-19T03:00:00Z");
const originalTz = process.env.TZ;

function useTimeZone(tz: string) {
  process.env.TZ = tz;
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  for (const model of Object.values(prismaMock)) {
    for (const fn of Object.values(model)) fn.mockReset();
  }
});

afterEach(() => {
  vi.useRealTimers();
  process.env.TZ = originalTz;
});

describe("UTC day boundaries", () => {
  it.each(["UTC", "Asia/Kolkata", "America/Los_Angeles", "Pacific/Auckland"])(
    "ends the range on today's UTC date when the server runs in %s",
    (tz) => {
      useTimeZone(tz);

      expect(generateDateRange(3)).toEqual(["2026-09-17", "2026-09-18", "2026-09-19"]);
    },
  );

  it("labels a date by its UTC day in any server time zone", () => {
    useTimeZone("America/Los_Angeles");

    expect(formatDateLabel("2026-09-19")).toBe("Sep 19");
  });

  it("queries whole UTC days", () => {
    useTimeZone("Asia/Kolkata");

    expect(utcRangeBounds(["2026-09-17", "2026-09-19"])).toEqual({
      startDate: new Date("2026-09-17T00:00:00.000Z"),
      endDate: new Date("2026-09-19T23:59:59.999Z"),
    });
  });

  it("counts a scan from earlier today on a server east of UTC", async () => {
    useTimeZone("Asia/Kolkata");
    prismaMock.scanResult.findMany.mockResolvedValue([
      { createdAt: new Date("2026-09-19T01:00:00Z"), riskScore: 40, findings: [] },
    ]);

    const metrics = await fetchDailyScanMetrics("user-1", 3);

    expect(metrics.at(-1)).toMatchObject({ date: "Sep 19", scans: 1, avgRiskScore: 40 });
    const { where } = prismaMock.scanResult.findMany.mock.calls[0][0];
    expect(where.createdAt.lte).toEqual(new Date("2026-09-19T23:59:59.999Z"));
  });
});

describe("fetchDailyScanMetrics", () => {
  it("buckets scans by day with finding, critical and average risk totals", async () => {
    prismaMock.scanResult.findMany.mockResolvedValue([
      {
        createdAt: new Date("2026-09-18T10:00:00Z"),
        riskScore: 30,
        findings: [{ severity: "CRITICAL" }, { severity: "LOW" }],
      },
      {
        createdAt: new Date("2026-09-18T20:00:00Z"),
        riskScore: 45,
        findings: [{ severity: "CRITICAL" }],
      },
      // Outside the range: ignored.
      { createdAt: new Date("2026-08-01T00:00:00Z"), riskScore: 99, findings: [] },
    ]);

    const metrics = await fetchDailyScanMetrics("user-1", 2);

    expect(metrics).toEqual([
      { date: "Sep 18", scans: 2, findings: 3, criticalFindings: 2, avgRiskScore: 37.5 },
      { date: "Sep 19", scans: 0, findings: 0, criticalFindings: 0, avgRiskScore: 0 },
    ]);
    expect(prismaMock.scanResult.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          pullRequest: { repository: { userId: "user-1" } },
        }),
      }),
    );
  });

  it("returns nothing and skips the query for an empty range", async () => {
    expect(await fetchDailyScanMetrics("user-1", 0)).toEqual([]);
    expect(prismaMock.scanResult.findMany).not.toHaveBeenCalled();
  });
});

describe("fetchSeverityTrend", () => {
  it("counts each severity per day, folding INFO into low", async () => {
    const at = new Date("2026-09-19T02:00:00Z");
    prismaMock.finding.findMany.mockResolvedValue([
      { severity: "CRITICAL", createdAt: at },
      { severity: "HIGH", createdAt: at },
      { severity: "MEDIUM", createdAt: at },
      { severity: "LOW", createdAt: at },
      { severity: "INFO", createdAt: at },
      { severity: "UNKNOWN", createdAt: at },
      { severity: "HIGH", createdAt: new Date("2020-01-01T00:00:00Z") },
    ]);

    const trend = await fetchSeverityTrend("user-1", 2);

    expect(trend).toEqual([
      { date: "Sep 18", critical: 0, high: 0, medium: 0, low: 0 },
      { date: "Sep 19", critical: 1, high: 1, medium: 1, low: 2 },
    ]);
  });

  it("returns nothing for an empty range", async () => {
    expect(await fetchSeverityTrend("user-1", 0)).toEqual([]);
    expect(prismaMock.finding.findMany).not.toHaveBeenCalled();
  });
});

describe("fetchRepoSummaries", () => {
  it("summarises each repository and sorts by total findings", async () => {
    prismaMock.repository.findMany.mockResolvedValue([
      { id: "r-quiet", fullName: "org/quiet", pullRequests: [] },
      {
        id: "r-busy",
        fullName: "org/busy",
        pullRequests: [
          {
            scans: [
              {
                riskScore: 20,
                policyDecision: "PASS",
                createdAt: new Date("2026-09-10T00:00:00Z"),
                findings: [{ severity: "LOW" }, { severity: "INFO" }],
              },
              {
                riskScore: 70,
                policyDecision: "BLOCK",
                createdAt: new Date("2026-09-12T00:00:00Z"),
                findings: [{ severity: "CRITICAL" }, { severity: "HIGH" }, { severity: "MEDIUM" }],
              },
            ],
          },
          {
            scans: [
              {
                riskScore: 30,
                policyDecision: "PASS",
                createdAt: new Date("2026-09-11T00:00:00Z"),
                findings: [],
              },
            ],
          },
        ],
      },
    ]);

    const [busy, quiet] = await fetchRepoSummaries("user-1");

    expect(busy).toEqual({
      repositoryId: "r-busy",
      repositoryName: "org/busy",
      totalScans: 3,
      totalFindings: 5,
      criticalFindings: 1,
      highFindings: 1,
      mediumFindings: 1,
      lowFindings: 2,
      averageRiskScore: 40,
      lastScanAt: "2026-09-12T00:00:00.000Z",
      passRate: 67,
    });
    expect(quiet).toMatchObject({
      repositoryId: "r-quiet",
      totalScans: 0,
      averageRiskScore: 0,
      lastScanAt: null,
      passRate: 0,
    });
  });
});

describe("fetchTopFindingTypes", () => {
  it("returns counts with their share of the total", async () => {
    prismaMock.finding.groupBy.mockResolvedValue([
      { type: "SECRET", _count: { type: 3 } },
      { type: "VULNERABILITY", _count: { type: 1 } },
    ]);

    const types = await fetchTopFindingTypes("user-1", 7);

    expect(types).toEqual([
      { type: "SECRET", count: 3, percentage: 75 },
      { type: "VULNERABILITY", count: 1, percentage: 25 },
    ]);
    const { where } = prismaMock.finding.groupBy.mock.calls[0][0];
    expect(where.createdAt.gte).toEqual(new Date("2026-09-12T00:00:00.000Z"));
  });

  it("returns an empty list when there are no findings", async () => {
    prismaMock.finding.groupBy.mockResolvedValue([]);

    expect(await fetchTopFindingTypes("user-1")).toEqual([]);
  });
});

describe("fetchScanVelocity", () => {
  it("counts scans per day", async () => {
    prismaMock.scanResult.findMany.mockResolvedValue([
      { createdAt: new Date("2026-09-18T05:00:00Z") },
      { createdAt: new Date("2026-09-18T06:00:00Z") },
      { createdAt: new Date("2026-01-01T00:00:00Z") },
    ]);

    expect(await fetchScanVelocity("user-1", 2)).toEqual([
      { period: "Sep 18", count: 2 },
      { period: "Sep 19", count: 0 },
    ]);
  });

  it("returns nothing for an empty range", async () => {
    expect(await fetchScanVelocity("user-1", 0)).toEqual([]);
  });
});

describe("fetchAnalyticsSummary and getAnalyticsPayload", () => {
  function stubAggregates(avgRiskScore: number | null) {
    prismaMock.scanResult.count.mockResolvedValueOnce(8).mockResolvedValueOnce(6);
    prismaMock.finding.count.mockResolvedValue(12);
    prismaMock.pullRequest.count.mockResolvedValue(5);
    prismaMock.scanResult.aggregate.mockResolvedValue({ _avg: { riskScore: avgRiskScore } });
    prismaMock.scanResult.findMany.mockResolvedValue([]);
    prismaMock.finding.findMany.mockResolvedValue([]);
    prismaMock.finding.groupBy.mockResolvedValue([]);
    prismaMock.repository.findMany.mockResolvedValue([]);
  }

  it("combines the totals into a summary", async () => {
    stubAggregates(33.333);

    expect(await fetchAnalyticsSummary("user-1")).toEqual({
      totalScans: 8,
      totalFindings: 12,
      totalPRs: 5,
      overallPassRate: 75,
      avgRiskScore: 33.3,
      trendDirection: "flat",
    });
  });

  it("treats a missing average risk score as zero", async () => {
    stubAggregates(null);

    expect((await fetchAnalyticsSummary("user-1")).avgRiskScore).toBe(0);
  });

  it("assembles every section of the payload", async () => {
    stubAggregates(10);

    const payload = await getAnalyticsPayload("user-1", 2);

    expect(payload.dailyMetrics).toHaveLength(2);
    expect(payload.severityTrend).toHaveLength(2);
    expect(payload.scanVelocity).toHaveLength(2);
    expect(payload.repoSummaries).toEqual([]);
    expect(payload.topFindingTypes).toEqual([]);
    expect(payload.summary.totalScans).toBe(8);
  });
});
