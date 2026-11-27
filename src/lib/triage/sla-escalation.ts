/**
 * Deterministic Triage SLA Aging & Breach-Escalation Engine (#2209)
 *
 * Pure, server/client-safe module computing per-severity remediation deadlines,
 * elapsed SLA ratios, breach escalation tiers, and portfolio SLA compliance summaries.
 */

export type SlaSeverity = "CRITICAL" | "HIGH" | "MEDIUM" | "LOW" | "INFO";

export type SlaEscalationTier = "EXEMPT" | "ON_TRACK" | "AT_RISK" | "BREACHED" | "CRITICAL_BREACH";

export const DEFAULT_SLA_BUDGET_HOURS: Record<SlaSeverity, number> = {
  CRITICAL: 24,
  HIGH: 72,
  MEDIUM: 336, // 14 days
  LOW: 720, // 30 days
  INFO: 1440, // 60 days
};

const SEVERITY_PRIORITY: Record<SlaSeverity, number> = {
  CRITICAL: 4,
  HIGH: 3,
  MEDIUM: 2,
  LOW: 1,
  INFO: 0,
};

const CLOSED_TRIAGE_STATUSES = new Set(["RESOLVED", "FALSE_POSITIVE", "IGNORED", "DISMISSED"]);

export interface SlaFindingInput {
  id: string;
  severity: string;
  status?: string | null;
  createdAt: Date | string;
  title?: string;
  fileLocation?: string;
}

export interface SlaEvaluationOptions {
  now?: Date;
  budgetHours?: Partial<Record<SlaSeverity, number>>;
  atRiskThreshold?: number;
}

export interface FindingSlaAssessment {
  findingId: string;
  severity: SlaSeverity;
  status: string;
  tier: SlaEscalationTier;
  budgetHours: number;
  elapsedHours: number;
  remainingHours: number;
  overdueHours: number;
  elapsedRatio: number;
  deadlineAt: string;
  title?: string;
  fileLocation?: string;
}

export interface PortfolioSlaSummary {
  evaluatedAt: string;
  totalFindings: number;
  activeFindings: number;
  exemptFindings: number;
  onTrackCount: number;
  atRiskCount: number;
  breachedCount: number;
  criticalBreachCount: number;
  slaCompliancePercentage: number;
  breachesBySeverity: Record<SlaSeverity, number>;
  escalationQueue: FindingSlaAssessment[];
}

function normalizeSeverity(severity: string): SlaSeverity {
  const upper = severity.trim().toUpperCase();
  if (
    upper === "CRITICAL" ||
    upper === "HIGH" ||
    upper === "MEDIUM" ||
    upper === "LOW" ||
    upper === "INFO"
  ) {
    return upper;
  }
  return "MEDIUM";
}

function roundTwo(value: number): number {
  return Math.round(value * 100) / 100;
}

/**
 * Evaluate SLA deadline, elapsed ratio, and escalation tier for a single finding.
 */
export function evaluateFindingSla(
  finding: SlaFindingInput,
  options: SlaEvaluationOptions = {},
): FindingSlaAssessment {
  const now = options.now ?? new Date();
  const atRiskThreshold = options.atRiskThreshold ?? 0.75;
  const severity = normalizeSeverity(finding.severity);
  const status = (finding.status ?? "OPEN").trim().toUpperCase();

  const budgets: Record<SlaSeverity, number> = {
    ...DEFAULT_SLA_BUDGET_HOURS,
    ...options.budgetHours,
  };
  const budgetHours = Math.max(1, budgets[severity]);

  const createdMs = new Date(finding.createdAt).getTime();
  const safeCreatedMs = isNaN(createdMs) ? now.getTime() : createdMs;
  const deadlineMs = safeCreatedMs + budgetHours * 3_600_000;
  const elapsedHours = Math.max(0, (now.getTime() - safeCreatedMs) / 3_600_000);
  const remainingHours = (deadlineMs - now.getTime()) / 3_600_000;
  const overdueHours = Math.max(0, -remainingHours);
  const elapsedRatio = elapsedHours / budgetHours;

  let tier: SlaEscalationTier;
  if (CLOSED_TRIAGE_STATUSES.has(status)) {
    tier = "EXEMPT";
  } else if (elapsedRatio >= 2) {
    tier = "CRITICAL_BREACH";
  } else if (elapsedRatio > 1) {
    tier = "BREACHED";
  } else if (elapsedRatio >= atRiskThreshold) {
    tier = "AT_RISK";
  } else {
    tier = "ON_TRACK";
  }

  return {
    findingId: finding.id,
    severity,
    status,
    tier,
    budgetHours,
    elapsedHours: roundTwo(elapsedHours),
    remainingHours: roundTwo(remainingHours),
    overdueHours: roundTwo(overdueHours),
    elapsedRatio: roundTwo(elapsedRatio),
    deadlineAt: new Date(deadlineMs).toISOString(),
    title: finding.title,
    fileLocation: finding.fileLocation,
  };
}

/**
 * Evaluate SLA compliance across a portfolio of findings and produce a sorted escalation queue.
 */
export function evaluatePortfolioSla(
  findings: SlaFindingInput[],
  options: SlaEvaluationOptions = {},
): PortfolioSlaSummary {
  const now = options.now ?? new Date();
  const assessments = findings.map((f) => evaluateFindingSla(f, { ...options, now }));

  const breachesBySeverity: Record<SlaSeverity, number> = {
    CRITICAL: 0,
    HIGH: 0,
    MEDIUM: 0,
    LOW: 0,
    INFO: 0,
  };

  let exemptFindings = 0;
  let onTrackCount = 0;
  let atRiskCount = 0;
  let breachedCount = 0;
  let criticalBreachCount = 0;

  const escalationQueue: FindingSlaAssessment[] = [];

  for (const item of assessments) {
    switch (item.tier) {
      case "EXEMPT":
        exemptFindings++;
        break;
      case "ON_TRACK":
        onTrackCount++;
        break;
      case "AT_RISK":
        atRiskCount++;
        escalationQueue.push(item);
        break;
      case "BREACHED":
        breachedCount++;
        breachesBySeverity[item.severity]++;
        escalationQueue.push(item);
        break;
      case "CRITICAL_BREACH":
        criticalBreachCount++;
        breachesBySeverity[item.severity]++;
        escalationQueue.push(item);
        break;
    }
  }

  const activeFindings = assessments.length - exemptFindings;
  const compliantActive = onTrackCount + atRiskCount;
  const slaCompliancePercentage =
    activeFindings === 0 ? 100 : roundTwo((compliantActive / activeFindings) * 100);

  escalationQueue.sort((a, b) => {
    const sevDiff = SEVERITY_PRIORITY[b.severity] - SEVERITY_PRIORITY[a.severity];
    if (sevDiff !== 0) return sevDiff;
    return b.elapsedRatio - a.elapsedRatio;
  });

  return {
    evaluatedAt: now.toISOString(),
    totalFindings: assessments.length,
    activeFindings,
    exemptFindings,
    onTrackCount,
    atRiskCount,
    breachedCount,
    criticalBreachCount,
    slaCompliancePercentage,
    breachesBySeverity,
    escalationQueue,
  };
}
