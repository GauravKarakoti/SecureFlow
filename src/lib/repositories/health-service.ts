/**
 * Repository Security Health Aggregation Service (#1870).
 *
 * Runs efficient indexed queries to aggregate:
 *  - Open findings by severity (excluding dismissed and resolved findings)
 *  - Blocked PRs in the last 30 days
 *  - Median time to resolve
 *  - 0–100 health score
 *  - 8-week historical trend sparkline data
 *
 * Results are cached in-memory with a 60-second TTL to keep dashboard
 * page loads, sorting, and filtering snappy.
 */

import prisma from "@/lib/prisma";
import {
  calculateHealthScoreBreakdown,
  calculateHealthScore,
  type OpenFindingCounts,
} from "./health-score";
import { readCachedRepoHealth, writeCachedRepoHealth } from "./health-cache";
import type { RepositoryHealthItem, RepositoriesOverviewData, WeeklyTrendPoint } from "./types";

// ─── Helpers ──────────────────────────────────────────────────────────────────

export function calculateMedian(values: number[]): number | null {
  if (!values || values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 !== 0) {
    return sorted[mid];
  }
  return Math.round((sorted[mid - 1] + sorted[mid]) / 2);
}

export function formatResolutionDuration(ms: number | null): string {
  if (ms === null || ms < 0) return "—";
  const minutes = Math.round(ms / (60 * 1000));
  if (minutes < 60) {
    return `${Math.max(1, minutes)}m`;
  }
  const hours = ms / (60 * 60 * 1000);
  if (hours < 24) {
    return `${hours.toFixed(1)}h`;
  }
  const days = ms / (24 * 60 * 60 * 1000);
  return `${days.toFixed(1)}d`;
}

function formatWeekLabel(date: Date): string {
  const month = date.toLocaleString("en-US", { month: "short", timeZone: "UTC" });
  const day = date.getUTCDate();
  return `${month} ${day}`;
}

const SUPPRESSED_OR_RESOLVED_STATUSES = new Set([
  "RESOLVED",
  "FALSE_POSITIVE",
  "IGNORED",
  "DISMISSED",
]);

// ─── Main Service ─────────────────────────────────────────────────────────────

export async function fetchRepositoryHealthData(
  userId: string,
  options?: { forceRefresh?: boolean },
): Promise<RepositoriesOverviewData> {
  if (!options?.forceRefresh) {
    const cached = readCachedRepoHealth(userId);
    if (cached) return cached;
  }

  // 1. Fetch active repositories for the user
  const repos = await prisma.repository.findMany({
    where: { userId, isActive: true },
    select: {
      id: true,
      fullName: true,
      owner: true,
      createdAt: true,
    },
    orderBy: { fullName: "asc" },
  });

  if (repos.length === 0) {
    const emptyResult: RepositoriesOverviewData = {
      repositories: [],
      totalConnected: 0,
      averageHealthScore: null,
      totalOpenCritical: 0,
      totalOpenHigh: 0,
      totalBlockedPrs30Days: 0,
      cachedAt: Date.now(),
    };
    writeCachedRepoHealth(userId, emptyResult);
    return emptyResult;
  }

  const repoIds = repos.map((r: { id: string }) => r.id);
  const now = new Date();
  const thirtyDaysAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);

  // 2. Batch indexed queries
  const [triageRows, blockedPrGroups, scanRows, findingRows] = await Promise.all([
    // Triage states per repository
    prisma.findingTriage.findMany({
      where: { repositoryId: { in: repoIds } },
      select: {
        repositoryId: true,
        fingerprint: true,
        status: true,
        createdAt: true,
        resolvedAt: true,
        updatedAt: true,
      },
    }),

    // Blocked PRs in the last 30 days
    prisma.pullRequest.groupBy({
      by: ["repositoryId"],
      where: {
        repositoryId: { in: repoIds },
        status: "BLOCKED",
        createdAt: { gte: thirtyDaysAgo },
      },
      _count: { _all: true },
    }),

    // Scans across repositories
    prisma.scanResult.findMany({
      where: {
        pullRequest: { repositoryId: { in: repoIds } },
      },
      select: {
        id: true,
        createdAt: true,
        pullRequest: { select: { repositoryId: true } },
      },
      orderBy: { createdAt: "desc" },
    }),

    // Findings across repositories
    prisma.finding.findMany({
      where: {
        scanResult: {
          pullRequest: { repositoryId: { in: repoIds } },
        },
      },
      select: {
        severity: true,
        fingerprint: true,
        createdAt: true,
        scanResult: {
          select: {
            pullRequest: { select: { repositoryId: true } },
          },
        },
      },
    }),
  ]);

  // 3. Process Triage Rows
  const nonOpenByRepo = new Map<string, Set<string>>();
  const resolvedDurationsByRepo = new Map<string, number[]>();

  for (const triage of triageRows) {
    const repoId = triage.repositoryId;
    if (SUPPRESSED_OR_RESOLVED_STATUSES.has(triage.status)) {
      if (!nonOpenByRepo.has(repoId)) {
        nonOpenByRepo.set(repoId, new Set<string>());
      }
      nonOpenByRepo.get(repoId)!.add(triage.fingerprint);
    }

    if (triage.status === "RESOLVED") {
      const resolvedTimestamp = triage.resolvedAt
        ? triage.resolvedAt.getTime()
        : triage.updatedAt.getTime();
      const duration = Math.max(0, resolvedTimestamp - triage.createdAt.getTime());
      if (!resolvedDurationsByRepo.has(repoId)) {
        resolvedDurationsByRepo.set(repoId, []);
      }
      resolvedDurationsByRepo.get(repoId)!.push(duration);
    }
  }

  // 4. Process Blocked PRs
  const blockedPrCounts = new Map<string, number>();
  for (const group of blockedPrGroups) {
    blockedPrCounts.set(group.repositoryId, group._count._all);
  }

  // 5. Process Scans
  const scansByRepo = new Map<string, Array<{ createdAt: Date }>>();
  const lastScanByRepo = new Map<string, Date>();

  for (const scan of scanRows) {
    const repoId = scan.pullRequest.repositoryId;
    if (!scansByRepo.has(repoId)) {
      scansByRepo.set(repoId, []);
    }
    scansByRepo.get(repoId)!.push({ createdAt: scan.createdAt });

    if (!lastScanByRepo.has(repoId) || scan.createdAt > lastScanByRepo.get(repoId)!) {
      lastScanByRepo.set(repoId, scan.createdAt);
    }
  }

  // 6. Process Findings (deduplicating by fingerprint per repository)
  const repoFindings = new Map<
    string,
    Array<{ severity: string; fingerprint: string; createdAt: Date }>
  >();

  for (const f of findingRows) {
    const repoId = f.scanResult.pullRequest.repositoryId;
    if (!repoFindings.has(repoId)) {
      repoFindings.set(repoId, []);
    }
    repoFindings.get(repoId)!.push({
      severity: f.severity,
      fingerprint: f.fingerprint,
      createdAt: f.createdAt,
    });
  }

  // Define 8 weekly checkpoints (w1 = 7 weeks ago, ..., w8 = now)
  const weekMs = 7 * 24 * 60 * 60 * 1000;
  const weekTimestamps: Array<{ week: number; date: Date; label: string }> = [];
  for (let i = 0; i < 8; i++) {
    const offsetWeeks = 7 - i;
    const weekDate = new Date(now.getTime() - offsetWeeks * weekMs);
    weekTimestamps.push({
      week: i + 1,
      date: weekDate,
      label: formatWeekLabel(weekDate),
    });
  }

  // 7. Assemble per-repository summaries
  const repositorySummaries: RepositoryHealthItem[] = [];

  for (const repo of repos) {
    const repoId = repo.id;
    const repoScans = scansByRepo.get(repoId) ?? [];
    const hasScans = repoScans.length > 0;
    const lastScanAt = lastScanByRepo.get(repoId)?.toISOString() ?? null;

    const nonOpenSet = nonOpenByRepo.get(repoId) ?? new Set<string>();
    const findingsList = repoFindings.get(repoId) ?? [];

    const openFindings: OpenFindingCounts = {
      critical: 0,
      high: 0,
      medium: 0,
      low: 0,
      info: 0,
    };

    const seenFingerprints = new Set<string>();
    for (const finding of findingsList) {
      if (finding.fingerprint) {
        if (seenFingerprints.has(finding.fingerprint)) continue;
        seenFingerprints.add(finding.fingerprint);
        if (nonOpenSet.has(finding.fingerprint)) continue;
      }

      switch (finding.severity) {
        case "CRITICAL":
          openFindings.critical += 1;
          break;
        case "HIGH":
          openFindings.high += 1;
          break;
        case "MEDIUM":
          openFindings.medium += 1;
          break;
        case "LOW":
          openFindings.low += 1;
          break;
        case "INFO":
          openFindings.info += 1;
          break;
      }
    }

    const totalOpenFindings =
      openFindings.critical +
      openFindings.high +
      openFindings.medium +
      openFindings.low +
      openFindings.info;

    const blockedPrsLast30Days = blockedPrCounts.get(repoId) ?? 0;
    const resolvedDurations = resolvedDurationsByRepo.get(repoId) ?? [];
    const medianResolveTimeMs = calculateMedian(resolvedDurations);
    const medianResolveTimeFormatted = formatResolutionDuration(medianResolveTimeMs);

    const breakdown = calculateHealthScoreBreakdown({
      openFindings,
      blockedPrsLast30Days,
      medianResolveTimeMs,
      hasScans,
    });

    // 8-week trend calculation
    const trend: WeeklyTrendPoint[] = weekTimestamps.map((w) => {
      if (!hasScans) {
        return { week: w.week, weekLabel: w.label, score: null };
      }

      const scansUpToWeek = repoScans.filter((s) => s.createdAt <= w.date);
      if (scansUpToWeek.length === 0) {
        return { week: w.week, weekLabel: w.label, score: null };
      }

      // Open findings as of this week checkpoint
      const weekOpenFindings: OpenFindingCounts = {
        critical: 0,
        high: 0,
        medium: 0,
        low: 0,
        info: 0,
      };

      const weekSeenFingerprints = new Set<string>();
      for (const finding of findingsList) {
        if (finding.createdAt > w.date) continue;
        if (finding.fingerprint) {
          if (weekSeenFingerprints.has(finding.fingerprint)) continue;
          weekSeenFingerprints.add(finding.fingerprint);
          if (nonOpenSet.has(finding.fingerprint)) continue;
        }

        switch (finding.severity) {
          case "CRITICAL":
            weekOpenFindings.critical += 1;
            break;
          case "HIGH":
            weekOpenFindings.high += 1;
            break;
          case "MEDIUM":
            weekOpenFindings.medium += 1;
            break;
          case "LOW":
            weekOpenFindings.low += 1;
            break;
          case "INFO":
            weekOpenFindings.info += 1;
            break;
        }
      }

      const weekScore = calculateHealthScore({
        openFindings: weekOpenFindings,
        blockedPrsLast30Days,
        medianResolveTimeMs,
        hasScans: true,
      });

      return {
        week: w.week,
        weekLabel: w.label,
        score: weekScore,
      };
    });

    repositorySummaries.push({
      id: repo.id,
      fullName: repo.fullName,
      owner: repo.owner,
      hasScans,
      lastScanAt,
      openFindings: {
        ...openFindings,
        total: totalOpenFindings,
      },
      blockedPrsLast30Days,
      medianResolveTimeMs,
      medianResolveTimeFormatted,
      healthScore: breakdown.score,
      healthTier: breakdown.tier,
      trend,
    });
  }

  // 8. Overall Overview Metrics
  const rankedRepos = repositorySummaries.filter((r) => r.healthScore !== null);
  const averageHealthScore =
    rankedRepos.length > 0
      ? Math.round(
          rankedRepos.reduce((sum, r) => sum + (r.healthScore ?? 0), 0) / rankedRepos.length,
        )
      : null;

  const totalOpenCritical = repositorySummaries.reduce(
    (sum, r) => sum + r.openFindings.critical,
    0,
  );
  const totalOpenHigh = repositorySummaries.reduce((sum, r) => sum + r.openFindings.high, 0);
  const totalBlockedPrs30Days = repositorySummaries.reduce(
    (sum, r) => sum + r.blockedPrsLast30Days,
    0,
  );

  const overviewData: RepositoriesOverviewData = {
    repositories: repositorySummaries,
    totalConnected: repositorySummaries.length,
    averageHealthScore,
    totalOpenCritical,
    totalOpenHigh,
    totalBlockedPrs30Days,
    cachedAt: Date.now(),
  };

  writeCachedRepoHealth(userId, overviewData);
  return overviewData;
}
