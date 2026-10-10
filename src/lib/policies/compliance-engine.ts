/**
 * Compliance Policy Evaluation Engine
 *
 * Evaluates scan findings against compliance criteria and policy templates.
 * Enforces baseline guardrails (e.g., "Block any PR with unresolved SOC 2 critical secrets").
 */

import { parseSeverity, isAtLeast, type Severity } from "@/lib/severity";
import { normalizeFindingType } from "@/lib/finding-taxonomy";
import { mapFindingToComplianceTags, getFrameworkFromTag, ComplianceFramework } from "@/lib/compliance/taxonomy";
import { DEFAULT_COMPLIANCE_PACKS, type ComplianceFrameworkPack, type CompliancePackRuleConfig } from "./compliance-packs";
import type { CachedPolicy } from "./policy-cache";

export interface EvaluatedFinding {
  id?: string;
  type: string;
  severity: string;
  fileLocation?: string;
  lineStart?: number | null;
  explanation?: string;
  codeSnippet?: string;
  complianceTags?: string[];
  cwe?: string | string[];
}

export interface FrameworkComplianceStatus {
  framework: ComplianceFramework;
  status: "PASS" | "WARN" | "FAIL";
  totalViolations: number;
  criticalViolations: number;
  highViolations: number;
  mediumViolations: number;
  violatedTags: string[];
}

export interface ComplianceEvaluationResult {
  decision: "PASS" | "REVIEW REQUIRED" | "BLOCKED";
  isCompliant: boolean;
  blockedPacks: string[];
  violatedTags: string[];
  frameworks: Record<ComplianceFramework, FrameworkComplianceStatus>;
  summary: string;
  blockedFindingsCount: number;
  totalFindingsEvaluated: number;
}

/**
 * Ensures findings have their complianceTags populated.
 */
export function enrichFindingsWithComplianceTags<T extends EvaluatedFinding>(findings: T[]): Array<T & { complianceTags: string[] }> {
  return findings.map((f) => {
    const tags = f.complianceTags && f.complianceTags.length > 0
      ? f.complianceTags
      : mapFindingToComplianceTags(f);
    return {
      ...f,
      complianceTags: tags,
    };
  });
}

/**
 * Evaluates a set of findings against active compliance packs or templates.
 */
export function evaluateCompliancePolicies(
  findings: EvaluatedFinding[],
  activePacks: Array<ComplianceFrameworkPack | CachedPolicy> = DEFAULT_COMPLIANCE_PACKS,
): ComplianceEvaluationResult {
  const enriched = enrichFindingsWithComplianceTags(findings);
  const frameworks: Record<ComplianceFramework, FrameworkComplianceStatus> = {
    OWASP: { framework: "OWASP", status: "PASS", totalViolations: 0, criticalViolations: 0, highViolations: 0, mediumViolations: 0, violatedTags: [] },
    SOC2: { framework: "SOC2", status: "PASS", totalViolations: 0, criticalViolations: 0, highViolations: 0, mediumViolations: 0, violatedTags: [] },
    "PCI-DSS": { framework: "PCI-DSS", status: "PASS", totalViolations: 0, criticalViolations: 0, highViolations: 0, mediumViolations: 0, violatedTags: [] },
    HIPAA: { framework: "HIPAA", status: "PASS", totalViolations: 0, criticalViolations: 0, highViolations: 0, mediumViolations: 0, violatedTags: [] },
    ISO27001: { framework: "ISO27001", status: "PASS", totalViolations: 0, criticalViolations: 0, highViolations: 0, mediumViolations: 0, violatedTags: [] },
    NIST: { framework: "NIST", status: "PASS", totalViolations: 0, criticalViolations: 0, highViolations: 0, mediumViolations: 0, violatedTags: [] },
  };

  const blockedPacks = new Set<string>();
  const violatedTags = new Set<string>();
  let isBlocked = false;
  let requiresReview = false;
  let blockedFindingsCount = 0;

  for (const finding of enriched) {
    const sev = parseSeverity(finding.severity);
    const cat = normalizeFindingType(finding.type);
    let findingCausesBlock = false;

    // Record violations by framework
    for (const tag of finding.complianceTags) {
      violatedTags.add(tag);
      const fw = getFrameworkFromTag(tag);
      if (fw !== "UNKNOWN" && frameworks[fw]) {
        frameworks[fw].totalViolations++;
        if (!frameworks[fw].violatedTags.includes(tag)) {
          frameworks[fw].violatedTags.push(tag);
        }

        if (sev === "CRITICAL") frameworks[fw].criticalViolations++;
        else if (sev === "HIGH") frameworks[fw].highViolations++;
        else if (sev === "MEDIUM") frameworks[fw].mediumViolations++;
      }
    }

    // Evaluate against each active pack
    for (const pack of activePacks) {
      const rules: CompliancePackRuleConfig = (pack as any).rules || {};
      const packTags: string[] = (pack as any).complianceTags || [];

      // Check if finding matches any tags of the pack
      const matchesPack = packTags.length === 0 || finding.complianceTags.some((t) => packTags.includes(t));

      if (!matchesPack) continue;

      // 1. Critical Secrets Guard (e.g. SOC 2 / PCI-DSS / HIPAA)
      if (rules.blockOnCriticalSecrets && cat === "SECRET" && (sev === "CRITICAL" || sev === "HIGH")) {
        isBlocked = true;
        findingCausesBlock = true;
        blockedPacks.add(pack.name);
      }

      // 2. Critical Vulnerability Guard
      if (rules.blockOnCriticalVulnerabilities && sev === "CRITICAL") {
        isBlocked = true;
        findingCausesBlock = true;
        blockedPacks.add(pack.name);
      }

      // 3. High Vulnerability Guard
      if (rules.blockOnHighVulnerabilities && sev === "HIGH") {
        isBlocked = true;
        findingCausesBlock = true;
        blockedPacks.add(pack.name);
      }

      // 4. Block on specific tag lists
      if (rules.blockedComplianceTags && rules.blockedComplianceTags.length > 0) {
        const matchesBlockedTag = finding.complianceTags.some((t) => rules.blockedComplianceTags?.includes(t));
        if (matchesBlockedTag && (sev === "CRITICAL" || sev === "HIGH")) {
          isBlocked = true;
          findingCausesBlock = true;
          blockedPacks.add(pack.name);
        }
      }

      // 5. Review required for medium findings
      if (rules.requireReviewOnMedium && isAtLeast(finding.severity, "MEDIUM")) {
        requiresReview = true;
      }
    }

    if (findingCausesBlock) {
      blockedFindingsCount++;
    }
  }

  // Update Framework Statuses
  for (const fw of Object.keys(frameworks) as ComplianceFramework[]) {
    const entry = frameworks[fw];
    if (entry.criticalViolations > 0 || (entry.highViolations > 0 && (fw === "PCI-DSS" || fw === "OWASP"))) {
      entry.status = "FAIL";
    } else if (entry.totalViolations > 0) {
      entry.status = "WARN";
    } else {
      entry.status = "PASS";
    }
  }

  let decision: "PASS" | "REVIEW REQUIRED" | "BLOCKED" = "PASS";
  if (isBlocked) {
    decision = "BLOCKED";
  } else if (requiresReview || Object.values(frameworks).some((f) => f.status === "WARN")) {
    decision = "REVIEW REQUIRED";
  }

  const blockedPacksList = Array.from(blockedPacks);
  const summary =
    decision === "BLOCKED"
      ? `Blocked by compliance policy (${blockedPacksList.join(", ")}): ${blockedFindingsCount} critical compliance violations detected.`
      : decision === "REVIEW REQUIRED"
        ? `Review required by compliance policy: ${enriched.length} findings require auditor triage.`
        : `All PR findings satisfy active compliance policy baselines.`;

  return {
    decision,
    isCompliant: decision === "PASS",
    blockedPacks: blockedPacksList,
    violatedTags: Array.from(violatedTags),
    frameworks,
    summary,
    blockedFindingsCount,
    totalFindingsEvaluated: enriched.length,
  };
}
