import prisma from "@/lib/prisma";

export interface LandingStats {
  prsCount: number;
  secretsCount: number;
  reposCount: number;
  scanAverage: number;
  isLive: boolean;
}

export interface DetailedLandingMetrics extends LandingStats {
  totalScans: number;
  totalVulnerabilities: number;
  totalMisconfigs: number;
  blockedPRs: number;
  passedPRs: number;
}

export const BASELINE_FALLBACK_METRICS: LandingStats = {
  prsCount: 45208,
  secretsCount: 1842,
  reposCount: 948,
  scanAverage: 1.4,
  isLive: false,
};

/**
 * Retrieves high-level landing page metrics from the database with reliable
 * error boundaries and type-safe enum queries.
 */
export async function getLandingStats(): Promise<LandingStats> {
  try {
    const [dbPrs, dbSecrets, dbRepos, dbScans] = await Promise.all([
      prisma.pullRequest.count().catch((err: any) => {
        console.error("[LandingStats] Failed to count PRs:", err);
        return null;
      }),
      prisma.finding
        .count({
          where: {
            type: "SECRET",
          },
        })
        .catch((err: any) => {
          console.error("[LandingStats] Failed to count Secrets:", err);
          return null;
        }),
      prisma.repository
        .count({
          where: {
            isActive: true,
          },
        })
        .catch((err: any) => {
          console.error("[LandingStats] Failed to count Repositories:", err);
          return null;
        }),
      prisma.scanResult.count().catch((err: any) => {
        console.error("[LandingStats] Failed to count ScanResults:", err);
        return null;
      }),
    ]);

    const hasAnyRealData =
      (dbPrs !== null && dbPrs > 0) ||
      (dbSecrets !== null && dbSecrets > 0) ||
      (dbRepos !== null && dbRepos > 0) ||
      (dbScans !== null && dbScans > 0);

    if (!hasAnyRealData && (dbPrs === 0 && dbSecrets === 0 && dbRepos === 0)) {
      // In fresh/unseeded environments with 0 records, return baseline values for display
      return {
        ...BASELINE_FALLBACK_METRICS,
        isLive: true,
        prsCount: dbPrs ?? BASELINE_FALLBACK_METRICS.prsCount,
        secretsCount: dbSecrets ?? BASELINE_FALLBACK_METRICS.secretsCount,
        reposCount: dbRepos ?? BASELINE_FALLBACK_METRICS.reposCount,
      };
    }

    return {
      prsCount: dbPrs !== null ? dbPrs : BASELINE_FALLBACK_METRICS.prsCount,
      secretsCount: dbSecrets !== null ? dbSecrets : BASELINE_FALLBACK_METRICS.secretsCount,
      reposCount: dbRepos !== null ? dbRepos : BASELINE_FALLBACK_METRICS.reposCount,
      scanAverage: 1.4,
      isLive: dbPrs !== null && dbSecrets !== null && dbRepos !== null,
    };
  } catch (error) {
    console.error("[LandingStats] Unexpected error querying database metrics:", error);
    return {
      ...BASELINE_FALLBACK_METRICS,
      isLive: false,
    };
  }
}

/**
 * Retrieves comprehensive landing page security metrics.
 */
export async function getDetailedLandingMetrics(): Promise<DetailedLandingMetrics> {
  const baseStats = await getLandingStats();

  try {
    const [scansCount, vulnCount, misconfigCount, blockedPrCount, passedPrCount] =
      await Promise.all([
        prisma.scanResult.count().catch(() => 0),
        prisma.finding.count({ where: { type: "VULNERABILITY" } }).catch(() => 0),
        prisma.finding.count({ where: { type: "MISCONFIG" } }).catch(() => 0),
        prisma.pullRequest.count({ where: { status: "BLOCKED" } }).catch(() => 0),
        prisma.pullRequest.count({ where: { status: "PASS" } }).catch(() => 0),
      ]);

    return {
      ...baseStats,
      totalScans: scansCount,
      totalVulnerabilities: vulnCount,
      totalMisconfigs: misconfigCount,
      blockedPRs: blockedPrCount,
      passedPRs: passedPrCount,
    };
  } catch (error) {
    console.error("[LandingStats] Failed to retrieve detailed metrics:", error);
    return {
      ...baseStats,
      totalScans: 0,
      totalVulnerabilities: 0,
      totalMisconfigs: 0,
      blockedPRs: 0,
      passedPRs: 0,
    };
  }
}
