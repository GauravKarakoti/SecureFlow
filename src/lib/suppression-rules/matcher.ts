/**
 * Suppression Rules Matching Engine (#1891).
 *
 * Evaluates findings against installation-wide suppression rules.
 * Applies at scan time after repository-level fingerprint dismissals,
 * marking matches with SUPPRESSED_BY_RULE and recording the rule ID.
 */

import { compileIgnorePatterns } from "@/lib/armor/scanner";
import { normalizeGatePath } from "@/lib/armor/iq";
import { normalizeFindingTypeEnum } from "@/lib/finding-taxonomy";
import {
  evaluateInlinePragmaSuppressions,
  type EvaluateInlinePragmaResult,
  type ParseInlinePragmasOptions,
  type PragmaFindingTarget,
} from "./inline-pragma";

export interface SuppressionRuleLike {
  id: string;
  name: string;
  description?: string | null;
  scope: string; // "ALL" | "SELECTED"
  repositoryIds: string[];
  matchPolicy?: string | null;
  matchCategory?: string | null;
  pathGlob?: string | null;
  reason: string;
  expiresAt?: Date | string | null;
}

export interface FindingMatchTarget {
  type: string;
  severity?: string;
  fileLocation: string;
  description?: string | null;
  explanation?: string | null;
  policyName?: string | null;
  fingerprint?: string;
  suppressionStatus?: string | null;
  suppressionRuleId?: string | null;
}

export interface RuleSuppressionMatch<T extends FindingMatchTarget = FindingMatchTarget> {
  finding: T;
  rule: SuppressionRuleLike;
}

export interface EvaluateSuppressionResult<T extends FindingMatchTarget = FindingMatchTarget> {
  activeFindings: T[];
  suppressedFindings: T[];
  ruleMatches: RuleSuppressionMatch<T>[];
  suppressedCount: number;
}

/**
 * Checks if a suppression rule has not expired as of the reference time.
 */
export function isRuleActive(rule: SuppressionRuleLike, now: Date = new Date()): boolean {
  if (!rule.expiresAt) return true;
  const expiry = new Date(rule.expiresAt);
  if (isNaN(expiry.getTime())) return true;
  return expiry.getTime() > now.getTime();
}

/**
 * Checks if a suppression rule applies to the given repository ID.
 */
export function isRuleInScope(rule: SuppressionRuleLike, repositoryId?: string | null): boolean {
  if (rule.scope === "ALL") return true;
  if (!repositoryId) return false;
  return Array.isArray(rule.repositoryIds) && rule.repositoryIds.includes(repositoryId);
}

/**
 * Determines whether a single finding matches a suppression rule.
 * Requires:
 *  1. Rule is active (not expired)
 *  2. Rule is in scope for the repository
 *  3. Finding satisfies all specified match criteria (category, policy, path glob)
 */
export function matchesSuppressionRule(
  finding: FindingMatchTarget,
  rule: SuppressionRuleLike,
  repositoryId?: string | null,
  now: Date = new Date(),
): boolean {
  if (!isRuleActive(rule, now)) return false;
  if (!isRuleInScope(rule, repositoryId)) return false;

  let hasCriteria = false;

  // 1. Match category (e.g. "SECRET", "VULNERABILITY", "MISCONFIG")
  if (rule.matchCategory && rule.matchCategory.trim().length > 0) {
    hasCriteria = true;
    const targetCategory = rule.matchCategory.trim().toUpperCase();
    const normalizedFindingType = normalizeFindingTypeEnum(finding.type);

    const matchesType =
      normalizedFindingType === targetCategory ||
      finding.type.toUpperCase() === targetCategory ||
      finding.type.toUpperCase().includes(targetCategory);

    if (!matchesType) return false;
  }

  // 2. Match policy (e.g. policy name, signature, or keyword)
  if (rule.matchPolicy && rule.matchPolicy.trim().length > 0) {
    hasCriteria = true;
    const targetPolicy = rule.matchPolicy.trim().toLowerCase();
    const policyName = (finding.policyName || "").toLowerCase();
    const description = (finding.description || "").toLowerCase();
    const explanation = (finding.explanation || "").toLowerCase();
    const findingType = (finding.type || "").toLowerCase();

    const matchesPolicy =
      policyName.includes(targetPolicy) ||
      description.includes(targetPolicy) ||
      explanation.includes(targetPolicy) ||
      findingType.includes(targetPolicy);

    if (!matchesPolicy) return false;
  }

  // 3. Match path glob (e.g. "fixtures/**", "*.test.ts")
  if (rule.pathGlob && rule.pathGlob.trim().length > 0) {
    hasCriteria = true;
    const normalizedPath = normalizeGatePath(finding.fileLocation || "");
    const regexes = compileIgnorePatterns([rule.pathGlob.trim()]);
    const matchesPath = regexes.some((re) => re.test(normalizedPath));

    if (!matchesPath) return false;
  }

  // If no criteria was specified at all, rule matches everything in scope
  return hasCriteria ? true : true;
}

/**
 * Evaluates a list of findings against active installation suppression rules.
 * Separates into active findings (continue to check runs and scoring) and rule-suppressed findings.
 */
export function evaluateSuppressionRules<T extends FindingMatchTarget>(
  findings: readonly T[],
  rules: readonly SuppressionRuleLike[],
  repositoryId?: string | null,
  now: Date = new Date(),
): EvaluateSuppressionResult<T> {
  const activeFindings: T[] = [];
  const suppressedFindings: T[] = [];
  const ruleMatches: RuleSuppressionMatch<T>[] = [];

  // Filter down to rules that are active and in scope for this repository
  const applicableRules = rules.filter(
    (rule) => isRuleActive(rule, now) && isRuleInScope(rule, repositoryId),
  );

  for (const finding of findings) {
    let matchedRule: SuppressionRuleLike | undefined;

    for (const rule of applicableRules) {
      if (matchesSuppressionRule(finding, rule, repositoryId, now)) {
        matchedRule = rule;
        break;
      }
    }

    if (matchedRule) {
      const suppressedFinding = {
        ...finding,
        suppressionStatus: "SUPPRESSED_BY_RULE",
        suppressionRuleId: matchedRule.id,
      };
      suppressedFindings.push(suppressedFinding);
      ruleMatches.push({ finding: suppressedFinding, rule: matchedRule });
    } else {
      activeFindings.push(finding);
    }
  }

  return {
    activeFindings,
    suppressedFindings,
    ruleMatches,
    suppressedCount: suppressedFindings.length,
  };
}

/**
 * Evaluate both inline source-code pragmas and installation-wide suppression rules.
 */
export function evaluateAllSuppressions<T extends FindingMatchTarget & PragmaFindingTarget>(
  findings: T[],
  rules: SuppressionRuleLike[],
  sourceByFile: Record<string, string>,
  options: {
    repositoryId?: string | null;
    now?: Date;
    strictPragmaReason?: boolean;
  } = {},
): {
  activeFindings: T[];
  suppressedFindings: T[];
  pragmaResult: EvaluateInlinePragmaResult<T>;
  ruleResult: EvaluateSuppressionResult<T>;
} {
  const pragmaOptions: ParseInlinePragmasOptions = {
    now: options.now,
    strictReason: options.strictPragmaReason,
  };
  const pragmaResult = evaluateInlinePragmaSuppressions(findings, sourceByFile, pragmaOptions);
  const ruleResult = evaluateSuppressionRules(
    pragmaResult.activeFindings,
    rules,
    options.repositoryId,
    options.now,
  );

  return {
    activeFindings: ruleResult.activeFindings,
    suppressedFindings: [...pragmaResult.suppressedFindings, ...ruleResult.suppressedFindings],
    pragmaResult,
    ruleResult,
  };
}
