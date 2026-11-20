/**
 * Repository Security Health Score Engine (#1870).
 *
 * Computes a standardized 0–100 health score for connected repositories based on:
 *  1. Open findings by severity (weighted penalty).
 *  2. Blocked pull requests in the last 30 days (operational gating penalty).
 *  3. Median time to resolve findings (remediation velocity penalty).
 *
 * Pure and dependency-free so the arithmetic and tier mappings are directly unit-tested.
 */

export interface OpenFindingCounts {
  critical: number;
  high: number;
  medium: number;
  low: number;
  info: number;
}

export type HealthScoreTier = "EXCELLENT" | "GOOD" | "NEEDS_ATTENTION" | "AT_RISK" | "UNRANKED";

export interface HealthScoreInput {
  openFindings: OpenFindingCounts;
  blockedPrsLast30Days: number;
  medianResolveTimeMs: number | null;
  hasScans: boolean;
}

export interface HealthScoreBreakdown {
  score: number | null;
  tier: HealthScoreTier;
  baseScore: number;
  criticalPenalty: number;
  highPenalty: number;
  mediumPenalty: number;
  lowPenalty: number;
  infoPenalty: number;
  findingsPenalty: number;
  blockedPrsPenalty: number;
  resolveTimePenalty: number;
  totalDeductions: number;
}

// ─── Constants & Weights ──────────────────────────────────────────────────────

export const BASE_SCORE = 100;

export const WEIGHTS = {
  criticalFinding: 15,
  maxCriticalPenalty: 50,

  highFinding: 8,
  maxHighPenalty: 30,

  mediumFinding: 3,
  maxMediumPenalty: 15,

  lowFinding: 1,
  maxLowPenalty: 5,

  infoFinding: 0,
  maxFindingsPenalty: 80,

  blockedPr: 5,
  maxBlockedPrsPenalty: 20,
} as const;

export const RESOLUTION_TIME_THRESHOLDS_MS = {
  fast: 2 * 24 * 60 * 60 * 1000, // <= 2 days: 0 penalty
  moderate: 7 * 24 * 60 * 60 * 1000, // <= 7 days: 3 penalty
  slow: 14 * 24 * 60 * 60 * 1000, // <= 14 days: 6 penalty
  // > 14 days: 10 penalty
} as const;

export const HEALTH_SCORE_FORMULA_DOCS = {
  title: "Repository Health Score Calculation",
  baseScore: BASE_SCORE,
  maxFindingsPenalty: WEIGHTS.maxFindingsPenalty,
  maxBlockedPrsPenalty: WEIGHTS.maxBlockedPrsPenalty,
  rules: [
    {
      metric: "Critical Findings",
      formula: `-${WEIGHTS.criticalFinding} pts each (max -${WEIGHTS.maxCriticalPenalty} pts)`,
    },
    {
      metric: "High Findings",
      formula: `-${WEIGHTS.highFinding} pts each (max -${WEIGHTS.maxHighPenalty} pts)`,
    },
    {
      metric: "Medium Findings",
      formula: `-${WEIGHTS.mediumFinding} pts each (max -${WEIGHTS.maxMediumPenalty} pts)`,
    },
    {
      metric: "Low Findings",
      formula: `-${WEIGHTS.lowFinding} pt each (max -${WEIGHTS.maxLowPenalty} pts)`,
    },
    {
      metric: "Blocked PRs (30d)",
      formula: `-${WEIGHTS.blockedPr} pts each (max -${WEIGHTS.maxBlockedPrsPenalty} pts)`,
    },
    {
      metric: "Median Resolution Time",
      formula:
        "-0 pts (<= 2d), -3 pts (2-7d), -6 pts (7-14d), -10 pts (> 14d). Unpenalized if no resolved findings.",
    },
  ],
  summary:
    "Health Score = Base (100) - Findings Penalty (max 80) - Blocked PRs Penalty (max 20) - Remediation Velocity Penalty (max 10). Clamped between 0 and 100. Repositories with no scans remain Unranked.",
};

// ─── Calculation Functions ────────────────────────────────────────────────────

/**
 * Calculates the resolve time penalty in points.
 */
export function calculateResolveTimePenalty(medianResolveTimeMs: number | null): number {
  if (medianResolveTimeMs === null || medianResolveTimeMs <= RESOLUTION_TIME_THRESHOLDS_MS.fast) {
    return 0;
  }
  if (medianResolveTimeMs <= RESOLUTION_TIME_THRESHOLDS_MS.moderate) {
    return 3;
  }
  if (medianResolveTimeMs <= RESOLUTION_TIME_THRESHOLDS_MS.slow) {
    return 6;
  }
  return 10;
}

/**
 * Determines the health tier label and styling class from the numerical score.
 */
export function getHealthScoreTier(score: number | null): HealthScoreTier {
  if (score === null) return "UNRANKED";
  if (score >= 90) return "EXCELLENT";
  if (score >= 75) return "GOOD";
  if (score >= 50) return "NEEDS_ATTENTION";
  return "AT_RISK";
}

/**
 * Computes the detailed breakdown and final 0-100 score for a repository.
 */
export function calculateHealthScoreBreakdown(input: HealthScoreInput): HealthScoreBreakdown {
  if (!input.hasScans) {
    return {
      score: null,
      tier: "UNRANKED",
      baseScore: BASE_SCORE,
      criticalPenalty: 0,
      highPenalty: 0,
      mediumPenalty: 0,
      lowPenalty: 0,
      infoPenalty: 0,
      findingsPenalty: 0,
      blockedPrsPenalty: 0,
      resolveTimePenalty: 0,
      totalDeductions: 0,
    };
  }

  const criticalPenalty = Math.min(
    WEIGHTS.maxCriticalPenalty,
    Math.max(0, input.openFindings.critical) * WEIGHTS.criticalFinding,
  );
  const highPenalty = Math.min(
    WEIGHTS.maxHighPenalty,
    Math.max(0, input.openFindings.high) * WEIGHTS.highFinding,
  );
  const mediumPenalty = Math.min(
    WEIGHTS.maxMediumPenalty,
    Math.max(0, input.openFindings.medium) * WEIGHTS.mediumFinding,
  );
  const lowPenalty = Math.min(
    WEIGHTS.maxLowPenalty,
    Math.max(0, input.openFindings.low) * WEIGHTS.lowFinding,
  );
  const infoPenalty = 0;

  const rawFindingsPenalty = criticalPenalty + highPenalty + mediumPenalty + lowPenalty;
  const findingsPenalty = Math.min(WEIGHTS.maxFindingsPenalty, rawFindingsPenalty);

  const blockedPrsPenalty = Math.min(
    WEIGHTS.maxBlockedPrsPenalty,
    Math.max(0, input.blockedPrsLast30Days) * WEIGHTS.blockedPr,
  );

  const resolveTimePenalty = calculateResolveTimePenalty(input.medianResolveTimeMs);

  const totalDeductions = findingsPenalty + blockedPrsPenalty + resolveTimePenalty;
  const score = Math.max(0, Math.min(100, Math.round(BASE_SCORE - totalDeductions)));

  return {
    score,
    tier: getHealthScoreTier(score),
    baseScore: BASE_SCORE,
    criticalPenalty,
    highPenalty,
    mediumPenalty,
    lowPenalty,
    infoPenalty,
    findingsPenalty,
    blockedPrsPenalty,
    resolveTimePenalty,
    totalDeductions,
  };
}

/**
 * Convenience helper returning just the numeric score (or null if unranked).
 */
export function calculateHealthScore(input: HealthScoreInput): number | null {
  return calculateHealthScoreBreakdown(input).score;
}
