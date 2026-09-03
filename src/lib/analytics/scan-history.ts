/**
 * Scan History & Trend Analytics (#analytics)
 *
 * Pure query-builders and data transformers for the Analytics dashboard.
 * Every function takes its inputs as arguments and returns plain objects,
 * so the arithmetic and grouping logic is unit-testable without a database.
 *
 * The server component in `src/app/dashboard/analytics/page.tsx` calls into
 * these helpers after fetching raw Prisma rows, and the client component
 * renders the resulting shapes directly.
 */

import prisma from "@/lib/prisma";
import { Prisma, FindingSeverity } from "@prisma/client";

// ─── Types ───────────────────────────────────────────────────────────────────

/** One day's aggregated metrics for the trend chart. */
export interface DailyScanMetric {
  /** Display label, e.g. "Aug 15" */
  date: string;
  /** Number of scans that completed this day */
  scans: number;
  /** Number of findings produced by those scans */
  findings: number;
  /** Number of critical-severity findings */
  criticalFindings: number;
  /** Average risk score (0–100) across scans this day */
  avgRiskScore: number;
}

/** Per-repository breakdown row for the comparison table. */
export interface RepoScanSummary {
  repositoryId: string;
  repositoryName: string;
  totalScans: number;
  totalFindings: number;
  criticalFindings: number;
  highFindings: number;
  mediumFindings: number;
  lowFindings: number;
  averageRiskScore: number;
  lastScanAt: string | null;
  passRate: number;
}

/** Severity bucket counts for a given time window. */
export interface SeverityTrendPoint {
  date: string;
  critical: number;
  high: number;
  medium: number;
  low: number;
}

/** Top finding type by count. */
export interface TopFindingType {
  type: string;
  count: number;
  percentage: number;
}

/** Scan velocity — scans per time unit. */
export interface ScanVelocity {
  period: string;
  count: number;
}

/** Complete analytics payload sent to the client component. */
export interface AnalyticsPayload {
  /** Daily trend data for the area chart */
  dailyMetrics: DailyScanMetric[];
  /** Severity breakdown over time for the stacked chart */
  severityTrend: SeverityTrendPoint[];
  /** Per-repository comparison table data */
  repoSummaries: RepoScanSummary[];
  /** Top 10 finding types ranked by frequency */
  topFindingTypes: TopFindingType[];
  /** Scan velocity data (scans per day for last 30 days) */
  scanVelocity: ScanVelocity[];
  /** Aggregate summary stats */
  summary: {
    totalScans: number;
    totalFindings: number;
    totalPRs: number;
    overallPassRate: number;
    avgRiskScore: number;
    trendDirection: "up" | "down" | "flat";
  };
}

// ─── Constants ───────────────────────────────────────────────────────────────

const DEFAULT_DAYS = 30;
const MAX_REPOS = 20;
const MAX_FINDING_TYPES = 10;

// ─── Pure Helpers (testable without DB) ──────────────────────────────────────

/**
 * Generate an array of date strings for the last `days` days.
 *
 * Returns ISO date strings (YYYY-MM-DD) ordered oldest-first so the chart
 * renders chronologically. The dashboard's area chart expects contiguous
 * entries even for days with zero activity, which is why this fills gaps.
 */
export function generateDateRange(days: number = DEFAULT_DAYS): string[] {
  const dates: string[] = [];
  const now = new Date();

  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(now);
    d.setDate(d.getDate() - i);
    d.setHours(0, 0, 0, 0);
    dates.push(d.toISOString().split("T")[0]);
  }

  return dates;
}

/**
 * Format a date string into a short display label.
 *
 * "2026-08-15" → "Aug 15"
 */
export function formatDateLabel(isoDate: string): string {
  const d = new Date(isoDate + "T00:00:00");
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

/**
 * Build a lookup map from ISO date → index in the date range array.
 */
export function buildDateIndex(dates: string[]): Map<string, number> {
  const map = new Map<string, number>();
  dates.forEach((d, i) => map.set(d, i));
  return map;
}

/**
 * Compute the trend direction from two halves of a numeric series.
 *
 * Splits the series in half, averages each half, and returns:
 *  - "up"   if the second half is ≥10% higher
 *  - "down" if the second half is ≥10% lower
 *  - "flat" otherwise
 */
export function computeTrendDirection(
  recentValues: number[],
  threshold: number = 0.10
): "up" | "down" | "flat" {
  if (recentValues.length < 2) return "flat";

  const mid = Math.floor(recentValues.length / 2);
  const firstHalf = recentValues.slice(0, mid);
  const secondHalf = recentValues.slice(mid);

  const avgFirst = firstHalf.reduce((a, b) => a + b, 0) / (firstHalf.length || 1);
  const avgSecond = secondHalf.reduce((a, b) => a + b, 0) / (secondHalf.length || 1);

  if (avgFirst === 0 && avgSecond === 0) return "flat";

  const change = avgFirst === 0
    ? avgSecond > 0 ? 1 : 0
    : (avgSecond - avgFirst) / avgFirst;

  if (change >= threshold) return "up";
  if (change <= -threshold) return "down";
  return "flat";
}

/**
 * Compute pass rate as a percentage (0–100).
 */
export function computePassRate(
  passedScans: number,
  totalScans: number
): number {
  if (totalScans === 0) return 0;
  return Math.round((passedScans / totalScans) * 100);
}

/**
 * Round a number to `precision` decimal places.
 */
export function roundTo(value: number, precision: number = 1): number {
  const factor = Math.pow(10, precision);
  return Math.round(value * factor) / factor;
}

// ─── Database Queries ─────────────────────────────────────────────────────────

/**
 * Fetch daily scan metrics for the last N days.
 *
 * Groups scan results by date and aggregates counts, finding totals, and
 * average risk scores. Days with zero scans still appear with zeroed metrics
 * so the chart renders a continuous line.
 */
export async function fetchDailyScanMetrics(
  userId: string,
  days: number = DEFAULT_DAYS
): Promise<DailyScanMetric[]> {
  const dateRange = generateDateRange(days);
  const dateIndex = buildDateIndex(dateRange);

  if (dateRange.length === 0) return [];

  const startDate = new Date(dateRange[0] + "T00:00:00");
  const endDate = new Date(dateRange[dateRange.length - 1] + "T23:59:59");

  // Fetch all scan results in the range with their finding counts
  const scanResults = await prisma.scanResult.findMany({
    where: {
      createdAt: {
        gte: startDate,
        lte: endDate,
      },
      pullRequest: {
        repository: {
          userId,
        },
      },
    },
    include: {
      findings: {
        select: {
          severity: true,
        },
      },
    },
    orderBy: { createdAt: "asc" },
  });

  // Initialize buckets for each day
  const metrics: DailyScanMetric[] = dateRange.map((isoDate) => ({
    date: formatDateLabel(isoDate),
    scans: 0,
    findings: 0,
    criticalFindings: 0,
    avgRiskScore: 0,
  }));

  // Aggregate into daily buckets
  const riskScoresByDay = new Map<number, number[]>();

  for (const result of scanResults) {
    const isoDate = result.createdAt.toISOString().split("T")[0];
    const idx = dateIndex.get(isoDate);
    if (idx === undefined) continue;

    metrics[idx].scans += 1;
    metrics[idx].findings += result.findings.length;

    for (const finding of result.findings) {
      if (finding.severity === "CRITICAL") {
        metrics[idx].criticalFindings += 1;
      }
    }

    if (!riskScoresByDay.has(idx)) {
      riskScoresByDay.set(idx, []);
    }
    riskScoresByDay.get(idx)!.push(result.riskScore);
  }

  // Compute average risk scores per day
  for (const [idx, scores] of riskScoresByDay) {
    const sum = scores.reduce((a, b) => a + b, 0);
    metrics[idx].avgRiskScore = roundTo(sum / scores.length);
  }

  return metrics;
}

/**
 * Fetch severity distribution over time for the stacked bar chart.
 *
 * Returns one point per day with counts per severity level.
 */
export async function fetchSeverityTrend(
  userId: string,
  days: number = DEFAULT_DAYS
): Promise<SeverityTrendPoint[]> {
  const dateRange = generateDateRange(days);
  const dateIndex = buildDateIndex(dateRange);

  if (dateRange.length === 0) return [];

  const startDate = new Date(dateRange[0] + "T00:00:00");
  const endDate = new Date(dateRange[dateRange.length - 1] + "T23:59:59");

  const findings = await prisma.finding.findMany({
    where: {
      createdAt: {
        gte: startDate,
        lte: endDate,
      },
      scanResult: {
        pullRequest: {
          repository: {
            userId,
          },
        },
      },
    },
    select: {
      severity: true,
      createdAt: true,
    },
    orderBy: { createdAt: "asc" },
  });

  const trend: SeverityTrendPoint[] = dateRange.map((isoDate) => ({
    date: formatDateLabel(isoDate),
    critical: 0,
    high: 0,
    medium: 0,
    low: 0,
  }));

  for (const finding of findings) {
    const isoDate = finding.createdAt.toISOString().split("T")[0];
    const idx = dateIndex.get(isoDate);
    if (idx === undefined) continue;

    switch (finding.severity) {
      case "CRITICAL":
        trend[idx].critical += 1;
        break;
      case "HIGH":
        trend[idx].high += 1;
        break;
      case "MEDIUM":
        trend[idx].medium += 1;
        break;
      case "LOW":
      case "INFO":
        trend[idx].low += 1;
        break;
    }
  }

  return trend;
}

/**
 * Fetch per-repository scan summaries for the comparison table.
 *
 * Joins repositories with their scan results and findings to produce a
 * ranked table of scan activity per repo.
 */
export async function fetchRepoSummaries(
  userId: string
): Promise<RepoScanSummary[]> {
  const repos = await prisma.repository.findMany({
    where: {
      userId,
      isActive: true,
    },
    include: {
      pullRequests: {
        include: {
          scans: {
            include: {
              findings: {
                select: {
                  severity: true,
                },
              },
            },
          },
        },
      },
    },
    orderBy: {
      pullRequests: {
        _count: "desc",
      },
    },
    take: MAX_REPOS,
  });

  const summaries: RepoScanSummary[] = repos.map((repo) => {
    let totalScans = 0;
    let totalFindings = 0;
    let criticalFindings = 0;
    let highFindings = 0;
    let mediumFindings = 0;
    let lowFindings = 0;
    let riskScoreSum = 0;
    let riskScoreCount = 0;
    let passedScans = 0;
    let lastScanAt: Date | null = null;

    for (const pr of repo.pullRequests) {
      for (const scan of pr.scans) {
        totalScans += 1;
        riskScoreSum += scan.riskScore;
        riskScoreCount += 1;

        if (scan.policyDecision === "PASS") {
          passedScans += 1;
        }

        const scanDate = scan.createdAt;
        if (!lastScanAt || scanDate > lastScanAt) {
          lastScanAt = scanDate;
        }

        for (const finding of scan.findings) {
          totalFindings += 1;
          switch (finding.severity) {
            case "CRITICAL":
              criticalFindings += 1;
              break;
            case "HIGH":
              highFindings += 1;
              break;
            case "MEDIUM":
              mediumFindings += 1;
              break;
            case "LOW":
            case "INFO":
              lowFindings += 1;
              break;
          }
        }
      }
    }

    return {
      repositoryId: repo.id,
      repositoryName: repo.fullName,
      totalScans,
      totalFindings,
      criticalFindings,
      highFindings,
      mediumFindings,
      lowFindings,
      averageRiskScore:
        riskScoreCount > 0 ? roundTo(riskScoreSum / riskScoreCount) : 0,
      lastScanAt: lastScanAt?.toISOString() ?? null,
      passRate: computePassRate(passedScans, totalScans),
    };
  });

  // Sort by total findings descending
  summaries.sort((a, b) => b.totalFindings - a.totalFindings);

  return summaries;
}

/**
 * Fetch top finding types ranked by frequency.
 */
export async function fetchTopFindingTypes(
  userId: string,
  days: number = DEFAULT_DAYS
): Promise<TopFindingType[]> {
  const startDate = new Date();
  startDate.setDate(startDate.getDate() - days);
  startDate.setHours(0, 0, 0, 0);

  const findings = await prisma.finding.groupBy({
    by: ["type"],
    where: {
      createdAt: { gte: startDate },
      scanResult: {
        pullRequest: {
          repository: {
            userId,
          },
        },
      },
    },
    _count: {
      type: true,
    },
    orderBy: {
      _count: {
        type: "desc",
      },
    },
    take: MAX_FINDING_TYPES,
  });

  const totalTypeFindings = findings.reduce(
    (sum, f) => sum + f._count.type,
    0
  );

  return findings.map((f) => ({
    type: f.type,
    count: f._count.type,
    percentage: totalTypeFindings > 0
      ? roundTo((f._count.type / totalTypeFindings) * 100)
      : 0,
  }));
}

/**
 * Fetch scan velocity — number of scans per day for the last 30 days.
 */
export async function fetchScanVelocity(
  userId: string,
  days: number = DEFAULT_DAYS
): Promise<ScanVelocity[]> {
  const dateRange = generateDateRange(days);
  const dateIndex = buildDateIndex(dateRange);

  if (dateRange.length === 0) return [];

  const startDate = new Date(dateRange[0] + "T00:00:00");
  const endDate = new Date(dateRange[dateRange.length - 1] + "T23:59:59");

  const scans = await prisma.scanResult.findMany({
    where: {
      createdAt: { gte: startDate, lte: endDate },
      pullRequest: {
        repository: { userId },
      },
    },
    select: { createdAt: true },
  });

  const counts: ScanVelocity[] = dateRange.map((isoDate) => ({
    period: formatDateLabel(isoDate),
    count: 0,
  }));

  for (const scan of scans) {
    const isoDate = scan.createdAt.toISOString().split("T")[0];
    const idx = dateIndex.get(isoDate);
    if (idx !== undefined) {
      counts[idx].count += 1;
    }
  }

  return counts;
}

/**
 * Fetch aggregate summary statistics.
 */
export async function fetchAnalyticsSummary(userId: string) {
  const thirtyDaysAgo = new Date();
  thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);
  thirtyDaysAgo.setHours(0, 0, 0, 0);

  const [totalScans, totalFindings, totalPRs, passCount, riskAgg] =
    await Promise.all([
      prisma.scanResult.count({
        where: {
          pullRequest: { repository: { userId } },
        },
      }),
      prisma.finding.count({
        where: {
          scanResult: {
            pullRequest: { repository: { userId } },
          },
        },
      }),
      prisma.pullRequest.count({
        where: {
          repository: { userId },
        },
      }),
      prisma.scanResult.count({
        where: {
          policyDecision: "PASS",
          pullRequest: { repository: { userId } },
        },
      }),
      prisma.scanResult.aggregate({
        where: {
          pullRequest: { repository: { userId } },
        },
        _avg: { riskScore: true },
      }),
    ]);

  // Compute trend direction from recent scan finding counts
  const recentMetrics = await fetchDailyScanMetrics(userId, 30);
  const findingCounts = recentMetrics.map((m) => m.findings);
  const trendDirection = computeTrendDirection(findingCounts);

  return {
    totalScans,
    totalFindings,
    totalPRs,
    overallPassRate: computePassRate(passCount, totalScans),
    avgRiskScore: roundTo(riskAgg._avg.riskScore ?? 0),
    trendDirection,
  };
}

/**
 * Compose the full analytics payload in a single call.
 *
 * This is the entry point called by the server component. It runs all
 * queries in parallel where possible and assembles the final shape.
 */
export async function getAnalyticsPayload(
  userId: string,
  days: number = DEFAULT_DAYS
): Promise<AnalyticsPayload> {
  const [dailyMetrics, severityTrend, repoSummaries, topFindingTypes, scanVelocity, summary] =
    await Promise.all([
      fetchDailyScanMetrics(userId, days),
      fetchSeverityTrend(userId, days),
      fetchRepoSummaries(userId),
      fetchTopFindingTypes(userId, days),
      fetchScanVelocity(userId, days),
      fetchAnalyticsSummary(userId),
    ]);

  return {
    dailyMetrics,
    severityTrend,
    repoSummaries,
    topFindingTypes,
    scanVelocity,
    summary,
  };
}
