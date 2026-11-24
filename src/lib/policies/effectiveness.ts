/**
 * Policy Effectiveness Analytics & Reporting Service (#2019)
 *
 * Computes per-policy effectiveness metrics:
 *  - Number of findings (hits)
 *  - Share dismissed as false positive (falsePositiveRate)
 *  - Share resolved (resolvedRate)
 *  - Average time to resolve (avgResolutionTime)
 *  - Status label: 'noisy' (high false positive rate >= 50% with >= 3 findings),
 *    'inactive' (0 hits), or 'healthy' (active with low false positive rate).
 *
 * Includes CSV export with formula injection protection (escapes cells starting with =, +, -, @).
 */

import prisma from "@/lib/prisma";
import { escapeCsvCell } from "@/lib/utils/csv";

export interface PolicyMetricRow {
  policyId: string;
  policyName: string;
  description: string;
  severity: string;
  isActive: boolean;
  totalFindings: number;
  falsePositiveCount: number;
  falsePositiveRate: number; // percentage (0 - 100)
  resolvedCount: number;
  resolvedRate: number; // percentage (0 - 100)
  openCount: number;
  avgResolutionTimeMs: number | null;
  avgResolutionTimeFormatted: string;
  status: "noisy" | "inactive" | "healthy";
}

export interface PolicyEffectivenessSummary {
  periodDays: number;
  totalPolicies: number;
  activePolicies: number;
  noisyPolicies: number;
  inactivePolicies: number;
  healthyPolicies: number;
  totalFindingsEvaluated: number;
  overallFalsePositiveRate: number;
  overallResolvedRate: number;
  policies: PolicyMetricRow[];
}

export interface RawFindingWithTriage {
  id: string;
  type: string;
  severity: string;
  fileLocation: string;
  explanation: string | null;
  createdAt: Date;
  fingerprint: string;
  triage?: {
    status: string;
    dismissalReason: string | null;
    createdAt: Date;
    resolvedAt: Date | null;
    updatedAt: Date;
  } | null;
}

export interface PolicyTemplateInput {
  id: string;
  name: string;
  description: string;
  severity: string;
  isDefault: boolean;
  rules?: unknown;
}

// ─── Thresholds ──────────────────────────────────────────────────────────────

/**
 * Thresholds for policy effectiveness classification:
 * - NOISY: False positive rate >= 50% with at least MIN_FINDINGS_FOR_NOISY (3) findings.
 * - INACTIVE: Exactly 0 findings in the evaluation period.
 * - HEALTHY: At least 1 finding and false positive rate < 50%.
 */
export const POLICY_NOISY_FP_RATE_THRESHOLD = 50; // >= 50%
export const MIN_FINDINGS_FOR_NOISY = 3;

/**
 * Formats duration in milliseconds into a readable human string ("4.2h", "1.5d", "45m", "—").
 */
export function formatDurationMs(ms: number | null | undefined): string {
  if (ms === null || ms === undefined || ms < 0 || isNaN(ms)) return "—";
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

/**
 * Checks whether a finding matches a policy template.
 * Matches if:
 * 1. Finding's explanation or type contains the policy name or rule conditions, or
 * 2. If the policy name/description matches keywords in finding explanation/type.
 */
const STOP_WORDS = new Set([
  "enforce",
  "block",
  "check",
  "prevent",
  "require",
  "requires",
  "rule",
  "rules",
  "policy",
  "policies",
  "for",
  "and",
  "the",
  "with",
  "without",
  "to",
  "in",
  "on",
  "of",
]);

function normalizeToken(token: string): string {
  const t = token.toLowerCase();
  if (t.endsWith("ies")) return t.slice(0, -3) + "y";
  if (t.endsWith("ing")) return t.slice(0, -3);
  if (t.endsWith("es")) return t.slice(0, -2);
  if (t.endsWith("s") && !t.endsWith("ss")) return t.slice(0, -1);
  return t;
}

/**
 * Pure function: Heuristic matcher connecting a finding to a policy template.
 *
 * Checks:
 * 1. Direct match: finding's explanation or type contains policy name or exact type match.
 * 2. Secret finding type matching secrets policy.
 * 3. Policy rule conditions matching file location or explanation.
 * 4. Distinguishing keywords from policy name matching explanation.
 */
export function doesFindingMatchPolicy(
  finding: { type: string; explanation?: string | null; fileLocation?: string | null },
  policy: { name: string; description: string; rules?: unknown },
): boolean {
  const policyNameLower = (policy.name || "").toLowerCase().trim();
  const descLower = (policy.description || "").toLowerCase().trim();
  const findingTypeLower = (finding.type || "").toLowerCase().trim();
  const explanationLower = (finding.explanation || "").toLowerCase().trim();
  const fileLocationLower = (finding.fileLocation || "").toLowerCase().trim();

  // 1. Direct type / name match
  if (
    (policyNameLower && explanationLower.includes(policyNameLower)) ||
    (policyNameLower && findingTypeLower === policyNameLower)
  ) {
    return true;
  }

  // 2. Secret keywords match
  if (
    findingTypeLower === "secret" &&
    (policyNameLower.includes("secret") ||
      descLower.includes("secret") ||
      descLower.includes("token"))
  ) {
    return true;
  }

  // 3. Check conditions in policy rules
  if (policy.rules && typeof policy.rules === "object") {
    const rulesObj = policy.rules as { conditions?: string[] };
    if (Array.isArray(rulesObj.conditions)) {
      for (const cond of rulesObj.conditions) {
        const condLower = cond.toLowerCase().replace(/[*]/g, "").trim();
        if (
          condLower &&
          (fileLocationLower.includes(condLower) || explanationLower.includes(condLower))
        ) {
          return true;
        }
      }
    }
  }

  // 4. Distinguishing words matching: all substantive keywords of policy name must match explanation
  const tokens = policyNameLower
    .split(/[\s_-]+/)
    .map((w) => w.replace(/[^a-z0-9]/gi, ""))
    .filter((w) => w.length > 2 && !STOP_WORDS.has(w));

  if (tokens.length > 0) {
    const allTokensMatch = tokens.every((token) => {
      const norm = normalizeToken(token);
      return explanationLower.includes(norm) || explanationLower.includes(token);
    });
    if (allTokensMatch) {
      return true;
    }
  }

  return false;
}

/**
 * Pure function: Calculates effectiveness metrics for a list of policies against findings.
 */
export function calculatePolicyMetrics(
  policies: PolicyTemplateInput[],
  userToggles: Map<string, boolean>,
  findings: RawFindingWithTriage[],
  periodDays: number = 30,
): PolicyEffectivenessSummary {
  const metricRows: PolicyMetricRow[] = [];

  let totalFindingsMatched = 0;
  let totalFPMatched = 0;
  let totalResolvedMatched = 0;

  for (const policy of policies) {
    const isActive = userToggles.has(policy.id)
      ? Boolean(userToggles.get(policy.id))
      : policy.isDefault;

    // Filter findings matching this policy
    const matchedFindings = findings.filter((f) => doesFindingMatchPolicy(f, policy));
    const totalFindings = matchedFindings.length;

    let falsePositiveCount = 0;
    let resolvedCount = 0;
    let openCount = 0;
    let totalResolvedDurationMs = 0;
    let resolvedDurationCount = 0;

    for (const f of matchedFindings) {
      const triage = f.triage;
      if (!triage || triage.status === "OPEN") {
        openCount++;
      } else if (
        triage.status === "FALSE_POSITIVE" ||
        triage.dismissalReason === "FALSE_POSITIVE"
      ) {
        falsePositiveCount++;
      } else if (triage.status === "RESOLVED") {
        resolvedCount++;
        const resolvedTime = triage.resolvedAt
          ? triage.resolvedAt.getTime()
          : triage.updatedAt.getTime();
        const duration = Math.max(0, resolvedTime - triage.createdAt.getTime());
        totalResolvedDurationMs += duration;
        resolvedDurationCount++;
      } else if (triage.status === "DISMISSED" || triage.status === "IGNORED") {
        // Other dismissals like ACCEPTED_RISK or WONT_FIX
        openCount++; // Treated as triaged non-FP
      }
    }

    const falsePositiveRate =
      totalFindings > 0 ? Math.round((falsePositiveCount / totalFindings) * 100) : 0;
    const resolvedRate = totalFindings > 0 ? Math.round((resolvedCount / totalFindings) * 100) : 0;

    const avgResolutionTimeMs =
      resolvedDurationCount > 0
        ? Math.round(totalResolvedDurationMs / resolvedDurationCount)
        : null;

    let status: "noisy" | "inactive" | "healthy" = "healthy";
    if (totalFindings === 0) {
      status = "inactive";
    } else if (
      falsePositiveRate >= POLICY_NOISY_FP_RATE_THRESHOLD &&
      totalFindings >= MIN_FINDINGS_FOR_NOISY
    ) {
      status = "noisy";
    }

    metricRows.push({
      policyId: policy.id,
      policyName: policy.name,
      description: policy.description,
      severity: policy.severity,
      isActive,
      totalFindings,
      falsePositiveCount,
      falsePositiveRate,
      resolvedCount,
      resolvedRate,
      openCount,
      avgResolutionTimeMs,
      avgResolutionTimeFormatted: formatDurationMs(avgResolutionTimeMs),
      status,
    });

    totalFindingsMatched += totalFindings;
    totalFPMatched += falsePositiveCount;
    totalResolvedMatched += resolvedCount;
  }

  // Sort noisy first, then highest findings count, then name
  metricRows.sort((a, b) => {
    if (a.status === "noisy" && b.status !== "noisy") return -1;
    if (b.status === "noisy" && a.status !== "noisy") return 1;
    if (b.totalFindings !== a.totalFindings) return b.totalFindings - a.totalFindings;
    return a.policyName.localeCompare(b.policyName);
  });

  const activeCount = metricRows.filter((r) => r.isActive).length;
  const noisyCount = metricRows.filter((r) => r.status === "noisy").length;
  const inactiveCount = metricRows.filter((r) => r.status === "inactive").length;
  const healthyCount = metricRows.filter((r) => r.status === "healthy").length;

  const overallFalsePositiveRate =
    totalFindingsMatched > 0 ? Math.round((totalFPMatched / totalFindingsMatched) * 100) : 0;
  const overallResolvedRate =
    totalFindingsMatched > 0 ? Math.round((totalResolvedMatched / totalFindingsMatched) * 100) : 0;

  return {
    periodDays,
    totalPolicies: metricRows.length,
    activePolicies: activeCount,
    noisyPolicies: noisyCount,
    inactivePolicies: inactiveCount,
    healthyPolicies: healthyCount,
    totalFindingsEvaluated: totalFindingsMatched,
    overallFalsePositiveRate,
    overallResolvedRate,
    policies: metricRows,
  };
}

// ─── CSV Export Functionality ─────────────────────────────────────────────────

/**
 * Generates an RFC 4180 compliant CSV table of policy effectiveness metrics
 * with strict formula-injection mitigation (escaping =, +, -, @).
 */
export function exportPolicyMetricsToCSV(
  input: PolicyMetricRow[] | PolicyEffectivenessSummary,
): string {
  const metrics = Array.isArray(input) ? input : input.policies;
  const headers = [
    "Policy ID",
    "Policy Name",
    "Severity",
    "Status",
    "Active",
    "Total Findings",
    "False Positive Count",
    "False Positive Share",
    "Resolved Count",
    "Resolved Share",
    "Open Count",
    "Avg Resolution Time",
    "Description",
  ];

  const lines = [headers.map(escapeCsvCell).join(",")];

  for (const m of metrics) {
    const row = [
      escapeCsvCell(m.policyId),
      escapeCsvCell(m.policyName),
      escapeCsvCell(m.severity),
      escapeCsvCell(m.status.toUpperCase()),
      escapeCsvCell(m.isActive ? "Yes" : "No"),
      escapeCsvCell(m.totalFindings),
      escapeCsvCell(m.falsePositiveCount),
      escapeCsvCell(`${m.falsePositiveRate}%`),
      escapeCsvCell(m.resolvedCount),
      escapeCsvCell(`${m.resolvedRate}%`),
      escapeCsvCell(m.openCount),
      escapeCsvCell(m.avgResolutionTimeFormatted),
      escapeCsvCell(m.description),
    ];
    lines.push(row.join(","));
  }

  return lines.join("\r\n");
}

// ─── Database Service ─────────────────────────────────────────────────────────

export async function fetchPolicyEffectivenessData(
  userId: string,
  days: number = 30,
): Promise<PolicyEffectivenessSummary> {
  const now = new Date();
  const cutoff = new Date(now.getTime() - days * 24 * 60 * 60 * 1000);

  // 1. Fetch all policy templates & user toggles
  const [templates, userToggles, userRepos] = await Promise.all([
    prisma.policyTemplate.findMany({
      orderBy: { createdAt: "desc" },
    }),
    prisma.userPolicyToggle.findMany({
      where: { userId },
    }),
    prisma.repository.findMany({
      where: { userId, isActive: true },
      select: { id: true },
    }),
  ]);

  const toggleMap = new Map<string, boolean>(
    userToggles.map((t: { policyTemplateId: string; isActive: boolean }) => [
      t.policyTemplateId,
      t.isActive,
    ]),
  );

  const repoIds = userRepos.map((r: { id: string }) => r.id);

  if (repoIds.length === 0 || templates.length === 0) {
    return calculatePolicyMetrics(templates as PolicyTemplateInput[], toggleMap, [], days);
  }

  // 2. Fetch findings and triage rows in the period
  const [findings, triageRows] = await Promise.all([
    prisma.finding.findMany({
      where: {
        scanResult: {
          pullRequest: { repositoryId: { in: repoIds } },
        },
        createdAt: { gte: cutoff },
      },
      select: {
        id: true,
        type: true,
        severity: true,
        fileLocation: true,
        explanation: true,
        fingerprint: true,
        createdAt: true,
        scanResult: {
          select: {
            pullRequest: {
              select: { repositoryId: true },
            },
          },
        },
      },
    }),
    prisma.findingTriage.findMany({
      where: {
        repositoryId: { in: repoIds },
      },
      select: {
        repositoryId: true,
        fingerprint: true,
        status: true,
        dismissalReason: true,
        createdAt: true,
        resolvedAt: true,
        updatedAt: true,
      },
    }),
  ]);

  // Index triage by repositoryId:fingerprint
  const triageMap = new Map<string, (typeof triageRows)[0]>();
  for (const t of triageRows) {
    triageMap.set(`${t.repositoryId}:${t.fingerprint}`, t);
  }

  const rawFindings: RawFindingWithTriage[] = findings.map(
    (f: {
      id: string;
      type: string;
      severity: string;
      fileLocation: string;
      explanation: string | null;
      fingerprint: string;
      createdAt: Date;
      scanResult?: {
        pullRequest?: {
          repositoryId: string;
        } | null;
      } | null;
    }) => {
      const repoId = f.scanResult?.pullRequest?.repositoryId;
      const triage = repoId ? triageMap.get(`${repoId}:${f.fingerprint}`) : null;
      return {
        id: f.id,
        type: f.type,
        severity: f.severity,
        fileLocation: f.fileLocation,
        explanation: f.explanation,
        fingerprint: f.fingerprint,
        createdAt: f.createdAt,
        triage: triage
          ? {
              status: String(triage.status),
              dismissalReason: triage.dismissalReason ? String(triage.dismissalReason) : null,
              createdAt: triage.createdAt,
              resolvedAt: triage.resolvedAt,
              updatedAt: triage.updatedAt,
            }
          : null,
      };
    },
  );

  return calculatePolicyMetrics(templates as PolicyTemplateInput[], toggleMap, rawFindings, days);
}
