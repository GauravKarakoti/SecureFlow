/**
 * Deterministic Baseline Diff & Regression Gate Evaluator (#2226)
 *
 * Compares current scan findings against a saved security baseline snapshot,
 * classifying NEW, PERSISTENT, RESOLVED, and SEVERITY_ESCALATED findings
 * and enforcing configurable zero-regression PR gate policies.
 */

export type BaselineSeverity = "CRITICAL" | "HIGH" | "MEDIUM" | "LOW" | "INFO";

export type BaselineDiffStatus = "NEW" | "PERSISTENT" | "RESOLVED" | "SEVERITY_ESCALATED";

export interface BaselineFindingLike {
  fingerprint?: string | null;
  type: string;
  severity: string;
  fileLocation: string;
  lineStart?: number | null;
  description?: string;
}

export interface ClassifiedBaselineFinding<T extends BaselineFindingLike = BaselineFindingLike> {
  status: BaselineDiffStatus;
  finding: T;
  previousSeverity?: BaselineSeverity;
  currentSeverity?: BaselineSeverity;
}

export interface BaselineGatePolicy {
  failOnNewCritical?: boolean;
  failOnSeverityEscalation?: boolean;
  maxNewHigh?: number;
  maxNetRegression?: number;
}

export type BaselineGateVerdict = "PASS" | "BLOCK";

export interface BaselineDiffResult<T extends BaselineFindingLike = BaselineFindingLike> {
  newFindings: T[];
  persistentFindings: T[];
  resolvedFindings: T[];
  escalatedFindings: Array<{
    finding: T;
    previousSeverity: BaselineSeverity;
    currentSeverity: BaselineSeverity;
  }>;
  netDelta: number;
  verdict: BaselineGateVerdict;
  blockReasons: string[];
  summary: {
    baselineTotal: number;
    currentTotal: number;
    newCount: number;
    persistentCount: number;
    resolvedCount: number;
    escalatedCount: number;
    newCriticalCount: number;
    newHighCount: number;
  };
}

const SEVERITY_RANK: Record<BaselineSeverity, number> = {
  INFO: 0,
  LOW: 1,
  MEDIUM: 2,
  HIGH: 3,
  CRITICAL: 4,
};

function normalizeSev(severity: string): BaselineSeverity {
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

function findingIdentityKey(finding: BaselineFindingLike): string {
  if (finding.fingerprint && finding.fingerprint.trim().length > 0) {
    return `fp:${finding.fingerprint.trim()}`;
  }
  const normalizedPath = finding.fileLocation.replace(/\\/g, "/").replace(/^\.\//, "");
  return `loc:${finding.type.trim().toUpperCase()}|${normalizedPath}|${finding.lineStart ?? 0}`;
}

/**
 * Diff current scan findings against baseline findings and evaluate regression gate policy.
 */
export function evaluateBaselineDiff<T extends BaselineFindingLike = BaselineFindingLike>(
  baselineFindings: T[],
  currentFindings: T[],
  policy: BaselineGatePolicy = {},
): BaselineDiffResult<T> {
  const failOnNewCritical = policy.failOnNewCritical ?? true;
  const failOnSeverityEscalation = policy.failOnSeverityEscalation ?? true;
  const maxNewHigh = policy.maxNewHigh ?? 0;

  const baselineMap = new Map<string, T>();
  for (const item of baselineFindings) {
    baselineMap.set(findingIdentityKey(item), item);
  }

  const matchedBaselineKeys = new Set<string>();
  const newFindings: T[] = [];
  const persistentFindings: T[] = [];
  const escalatedFindings: Array<{
    finding: T;
    previousSeverity: BaselineSeverity;
    currentSeverity: BaselineSeverity;
  }> = [];

  for (const current of currentFindings) {
    const key = findingIdentityKey(current);
    const prev = baselineMap.get(key);
    if (!prev) {
      newFindings.push(current);
      continue;
    }

    matchedBaselineKeys.add(key);
    const prevSev = normalizeSev(prev.severity);
    const currSev = normalizeSev(current.severity);

    if (SEVERITY_RANK[currSev] > SEVERITY_RANK[prevSev]) {
      escalatedFindings.push({
        finding: current,
        previousSeverity: prevSev,
        currentSeverity: currSev,
      });
    } else {
      persistentFindings.push(current);
    }
  }

  const resolvedFindings: T[] = [];
  for (const [key, item] of baselineMap.entries()) {
    if (!matchedBaselineKeys.has(key)) {
      resolvedFindings.push(item);
    }
  }

  const newCriticalCount = newFindings.filter(
    (f) => normalizeSev(f.severity) === "CRITICAL",
  ).length;
  const newHighCount = newFindings.filter((f) => normalizeSev(f.severity) === "HIGH").length;
  const netDelta = currentFindings.length - baselineFindings.length;

  const blockReasons: string[] = [];
  if (failOnNewCritical && newCriticalCount > 0) {
    blockReasons.push(
      `Detected ${newCriticalCount} new CRITICAL finding(s) not present in baseline`,
    );
  }
  if (newHighCount > maxNewHigh) {
    blockReasons.push(
      `New HIGH findings (${newHighCount}) exceed allowed threshold (${maxNewHigh})`,
    );
  }
  if (failOnSeverityEscalation && escalatedFindings.length > 0) {
    blockReasons.push(
      `Detected ${escalatedFindings.length} finding(s) whose severity escalated compared to baseline`,
    );
  }
  if (typeof policy.maxNetRegression === "number" && netDelta > policy.maxNetRegression) {
    blockReasons.push(
      `Net finding regression (${netDelta}) exceeds maxNetRegression (${policy.maxNetRegression})`,
    );
  }

  return {
    newFindings,
    persistentFindings,
    resolvedFindings,
    escalatedFindings,
    netDelta,
    verdict: blockReasons.length > 0 ? "BLOCK" : "PASS",
    blockReasons,
    summary: {
      baselineTotal: baselineFindings.length,
      currentTotal: currentFindings.length,
      newCount: newFindings.length,
      persistentCount: persistentFindings.length,
      resolvedCount: resolvedFindings.length,
      escalatedCount: escalatedFindings.length,
      newCriticalCount,
      newHighCount,
    },
  };
}
