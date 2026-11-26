/**
 * Dismissals by Category and Policy Reporting Service (#2096)
 *
 * Aggregates finding dismissals by structured category and policy/rule:
 * - Categories: TEST_CODE, MITIGATED_ELSEWHERE, ACCEPTED_RISK, FALSE_POSITIVE, WONT_FIX, UNSPECIFIED
 * - Grouped by policy / finding type
 * - Returns exact counts and percentages matching underlying database triage records
 */

import prisma from "@/lib/prisma";
import {
  DISMISSAL_REASONS,
  DISMISSAL_REASON_LABELS,
  type DismissalReason,
} from "./statuses";

export interface CategoryBreakdown {
  category: DismissalReason;
  label: string;
  count: number;
  percentage: number; // 0 - 100
}

export interface PolicyDismissalReportItem {
  policyName: string;
  totalDismissals: number;
  byCategory: Record<DismissalReason, number>;
  categories: CategoryBreakdown[];
  topCategory: {
    category: DismissalReason;
    label: string;
    count: number;
  } | null;
}

export interface DismissalReportSummary {
  totalDismissals: number;
  periodDays?: number;
  byCategory: Record<DismissalReason, number>;
  categoryBreakdown: CategoryBreakdown[];
  byPolicy: PolicyDismissalReportItem[];
}

export interface GetDismissalReportOptions {
  repositoryId?: string;
  userId?: string;
  periodDays?: number;
  startDate?: Date;
  endDate?: Date;
}

/**
 * Pure function to calculate category breakdown percentages from raw category counts.
 */
export function buildCategoryBreakdown(
  categoryCounts: Record<DismissalReason, number>,
  total: number,
): CategoryBreakdown[] {
  return DISMISSAL_REASONS.map((cat) => {
    const count = categoryCounts[cat] || 0;
    const percentage = total > 0 ? Math.round((count / total) * 1000) / 10 : 0;
    return {
      category: cat,
      label: DISMISSAL_REASON_LABELS[cat] || cat,
      count,
      percentage,
    };
  });
}

/**
 * Aggregates raw dismissal records into structured summary grouped by category and policy.
 */
export function aggregateDismissals(
  records: Array<{
    fingerprint: string;
    dismissalReason: string | null;
    policyName?: string | null;
    findingType?: string | null;
    dismissedAt?: Date | null;
  }>,
  periodDays?: number,
): DismissalReportSummary {
  const globalCounts: Record<DismissalReason, number> = {
    FALSE_POSITIVE: 0,
    ACCEPTED_RISK: 0,
    WONT_FIX: 0,
    TEST_CODE: 0,
    MITIGATED_ELSEWHERE: 0,
    UNSPECIFIED: 0,
  };

  const policyMap = new Map<string, Record<DismissalReason, number>>();

  for (const record of records) {
    const rawReason = record.dismissalReason?.toUpperCase() as DismissalReason;
    const category: DismissalReason =
      rawReason && (rawReason in globalCounts) ? rawReason : "UNSPECIFIED";

    globalCounts[category] = (globalCounts[category] || 0) + 1;

    const policy = record.policyName || record.findingType || "General Policy";
    if (!policyMap.has(policy)) {
      policyMap.set(policy, {
        FALSE_POSITIVE: 0,
        ACCEPTED_RISK: 0,
        WONT_FIX: 0,
        TEST_CODE: 0,
        MITIGATED_ELSEWHERE: 0,
        UNSPECIFIED: 0,
      });
    }

    const pCounts = policyMap.get(policy)!;
    pCounts[category] = (pCounts[category] || 0) + 1;
  }

  const totalDismissals = records.length;
  const categoryBreakdown = buildCategoryBreakdown(globalCounts, totalDismissals);

  const byPolicy: PolicyDismissalReportItem[] = Array.from(policyMap.entries()).map(
    ([policyName, counts]) => {
      const pTotal = Object.values(counts).reduce((sum, n) => sum + n, 0);
      const categories = buildCategoryBreakdown(counts, pTotal);

      let topCategory: PolicyDismissalReportItem["topCategory"] = null;
      let maxCount = -1;
      for (const cb of categories) {
        if (cb.count > maxCount && cb.count > 0) {
          maxCount = cb.count;
          topCategory = {
            category: cb.category,
            label: cb.label,
            count: cb.count,
          };
        }
      }

      return {
        policyName,
        totalDismissals: pTotal,
        byCategory: counts,
        categories,
        topCategory,
      };
    },
  ).sort((a, b) => b.totalDismissals - a.totalDismissals);

  return {
    totalDismissals,
    ...(periodDays !== undefined ? { periodDays } : {}),
    byCategory: globalCounts,
    categoryBreakdown,
    byPolicy,
  };
}

/**
 * Queries the database for dismissed findings and generates a report by category and policy.
 */
export async function getDismissalReport(
  options: GetDismissalReportOptions = {},
): Promise<DismissalReportSummary> {
  const where: any = {
    status: { in: ["DISMISSED", "FALSE_POSITIVE", "IGNORED"] },
  };

  if (options.repositoryId) {
    where.repositoryId = options.repositoryId;
  }

  if (options.periodDays && options.periodDays > 0) {
    const since = new Date(Date.now() - options.periodDays * 24 * 60 * 60 * 1000);
    where.dismissedAt = { gte: since };
  } else if (options.startDate || options.endDate) {
    where.dismissedAt = {};
    if (options.startDate) where.dismissedAt.gte = options.startDate;
    if (options.endDate) where.dismissedAt.lte = options.endDate;
  }

  const triages = await prisma.findingTriage.findMany({
    where,
    select: {
      fingerprint: true,
      dismissalReason: true,
      dismissedAt: true,
      repositoryId: true,
    },
  });

  if (triages.length === 0) {
    return aggregateDismissals([], options.periodDays);
  }

  // Look up finding types / policies for these fingerprints
  const fingerprints = triages.map((t: { fingerprint: string }) => t.fingerprint);
  const findings = await prisma.finding.findMany({
    where: {
      fingerprint: { in: fingerprints },
    },
    select: {
      fingerprint: true,
      type: true,
    },
    distinct: ["fingerprint"],
  });

  const typeByFingerprint = new Map<string, string>();
  for (const f of findings) {
    typeByFingerprint.set(f.fingerprint, f.type);
  }

  const mappedRecords = triages.map((t: { fingerprint: string; dismissalReason: string | null; dismissedAt: Date | null }) => ({
    fingerprint: t.fingerprint,
    dismissalReason: t.dismissalReason,
    dismissedAt: t.dismissedAt,
    findingType: typeByFingerprint.get(t.fingerprint) || "General Findings",
  }));

  return aggregateDismissals(mappedRecords, options.periodDays);
}
