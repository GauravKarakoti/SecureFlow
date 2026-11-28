/**
 * Policy Conflict Detector & Effective-Rule Precedence Resolver (#2225)
 *
 * Evaluates overlapping security policy rules across ORG, REPO, and BRANCH scopes,
 * detects same-scope contradictions and cross-scope overrides, and resolves
 * deterministic effective rules with full audit provenance.
 */

export type PolicyScope = "ORG" | "REPO" | "BRANCH";

export type PolicyAction = "BLOCK" | "WARN" | "ALLOW";

export interface ScopedPolicyRule {
  id: string;
  ruleKey: string;
  scope: PolicyScope;
  scopeTarget?: string;
  action: PolicyAction;
  severity?: "CRITICAL" | "HIGH" | "MEDIUM" | "LOW" | "INFO";
  pathGlob?: string;
  priority?: number;
  enabled?: boolean;
}

export type PolicyConflictKind = "CONFLICT_SAME_SCOPE" | "OVERRIDDEN_BY_HIGHER_SPECIFICITY";

export interface PolicyConflictDiagnostic {
  kind: PolicyConflictKind;
  ruleKey: string;
  pathGlob: string;
  winningRuleId: string;
  losingRuleId: string;
  winningScope: PolicyScope;
  losingScope: PolicyScope;
  winningAction: PolicyAction;
  losingAction: PolicyAction;
  message: string;
}

export interface EffectivePolicyDecision {
  ruleKey: string;
  pathGlob: string;
  effectiveRule: ScopedPolicyRule;
  overriddenRules: ScopedPolicyRule[];
}

export interface PolicyResolutionResult {
  effectiveRules: EffectivePolicyDecision[];
  conflicts: PolicyConflictDiagnostic[];
  hasHardConflicts: boolean;
}

const SCOPE_WEIGHT: Record<PolicyScope, number> = {
  ORG: 1,
  REPO: 2,
  BRANCH: 3,
};

const ACTION_STRICTNESS: Record<PolicyAction, number> = {
  ALLOW: 1,
  WARN: 2,
  BLOCK: 3,
};

function compareRulePrecedence(a: ScopedPolicyRule, b: ScopedPolicyRule): number {
  const scopeDiff = SCOPE_WEIGHT[a.scope] - SCOPE_WEIGHT[b.scope];
  if (scopeDiff !== 0) return scopeDiff;

  const prioDiff = (a.priority ?? 0) - (b.priority ?? 0);
  if (prioDiff !== 0) return prioDiff;

  // Deterministic tie-breaker: stricter action wins (BLOCK > WARN > ALLOW), then lexical id
  const strictDiff = ACTION_STRICTNESS[a.action] - ACTION_STRICTNESS[b.action];
  if (strictDiff !== 0) return strictDiff;

  return a.id.localeCompare(b.id);
}

/**
 * Resolve effective policy rules across ORG, REPO, and BRANCH scopes and report conflicts.
 */
export function resolvePolicyConflicts(rules: ScopedPolicyRule[]): PolicyResolutionResult {
  const activeRules = rules.filter((r) => r.enabled !== false);
  const grouped = new Map<string, ScopedPolicyRule[]>();

  for (const rule of activeRules) {
    const pathKey = (rule.pathGlob ?? "**").trim() || "**";
    const groupKey = `${rule.ruleKey.trim().toUpperCase()}::${pathKey}`;
    const bucket = grouped.get(groupKey);
    if (bucket) {
      bucket.push(rule);
    } else {
      grouped.set(groupKey, [rule]);
    }
  }

  const effectiveRules: EffectivePolicyDecision[] = [];
  const conflicts: PolicyConflictDiagnostic[] = [];

  for (const [, group] of grouped.entries()) {
    const sorted = [...group].sort((a, b) => compareRulePrecedence(b, a));
    const winner = sorted[0];
    const overriddenRules = sorted.slice(1);
    const pathGlob = (winner.pathGlob ?? "**").trim() || "**";

    for (const loser of overriddenRules) {
      const sameScope = winner.scope === loser.scope;
      const actionDiffers = winner.action !== loser.action || winner.severity !== loser.severity;

      if (sameScope && actionDiffers) {
        conflicts.push({
          kind: "CONFLICT_SAME_SCOPE",
          ruleKey: winner.ruleKey,
          pathGlob,
          winningRuleId: winner.id,
          losingRuleId: loser.id,
          winningScope: winner.scope,
          losingScope: loser.scope,
          winningAction: winner.action,
          losingAction: loser.action,
          message: `Same-scope contradiction in ${winner.scope} for ${winner.ruleKey} (${pathGlob}): ${winner.id} (${winner.action}) overrides ${loser.id} (${loser.action})`,
        });
      } else if (!sameScope && actionDiffers) {
        conflicts.push({
          kind: "OVERRIDDEN_BY_HIGHER_SPECIFICITY",
          ruleKey: winner.ruleKey,
          pathGlob,
          winningRuleId: winner.id,
          losingRuleId: loser.id,
          winningScope: winner.scope,
          losingScope: loser.scope,
          winningAction: winner.action,
          losingAction: loser.action,
          message: `${winner.scope} rule ${winner.id} (${winner.action}) overrides ${loser.scope} rule ${loser.id} (${loser.action}) for ${winner.ruleKey}`,
        });
      }
    }

    effectiveRules.push({
      ruleKey: winner.ruleKey,
      pathGlob,
      effectiveRule: winner,
      overriddenRules,
    });
  }

  const hasHardConflicts = conflicts.some((c) => c.kind === "CONFLICT_SAME_SCOPE");

  return {
    effectiveRules,
    conflicts,
    hasHardConflicts,
  };
}
