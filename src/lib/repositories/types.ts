import type { HealthScoreTier } from "./health-score";

export interface WeeklyTrendPoint {
  week: number; // 1 to 8 (1 = 7 weeks ago, 8 = current week)
  weekLabel: string; // e.g. "W1", "Oct 12"
  score: number | null;
}

export interface RepositoryHealthItem {
  id: string;
  fullName: string;
  owner: string;
  hasScans: boolean;
  lastScanAt: string | null;
  openFindings: {
    critical: number;
    high: number;
    medium: number;
    low: number;
    info: number;
    total: number;
  };
  blockedPrsLast30Days: number;
  medianResolveTimeMs: number | null;
  medianResolveTimeFormatted: string;
  healthScore: number | null;
  healthTier: HealthScoreTier;
  trend: WeeklyTrendPoint[];
}

export interface RepositoriesOverviewData {
  repositories: RepositoryHealthItem[];
  totalConnected: number;
  averageHealthScore: number | null;
  totalOpenCritical: number;
  totalOpenHigh: number;
  totalBlockedPrs30Days: number;
  cachedAt: number;
}
