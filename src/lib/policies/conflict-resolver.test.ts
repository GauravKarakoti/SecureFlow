import { describe, expect, it } from "vitest";
import { resolvePolicyConflicts, type ScopedPolicyRule } from "./conflict-resolver";
import { simulatePolicyConflicts } from "./preview-impact";

describe("Policy Conflict Detector & Precedence Resolver (#2225)", () => {
  it("resolves BRANCH > REPO > ORG precedence and records specificity overrides", () => {
    const rules: ScopedPolicyRule[] = [
      { id: "org-1", ruleKey: "SQL_INJECTION", scope: "ORG", action: "WARN" },
      { id: "repo-1", ruleKey: "SQL_INJECTION", scope: "REPO", action: "BLOCK" },
      { id: "branch-1", ruleKey: "SQL_INJECTION", scope: "BRANCH", action: "ALLOW" },
    ];

    const result = resolvePolicyConflicts(rules);
    expect(result.hasHardConflicts).toBe(false);
    expect(result.effectiveRules).toHaveLength(1);
    expect(result.effectiveRules[0].effectiveRule.id).toBe("branch-1");
    expect(result.effectiveRules[0].effectiveRule.action).toBe("ALLOW");
    expect(result.conflicts).toHaveLength(2);
    expect(result.conflicts.every((c) => c.kind === "OVERRIDDEN_BY_HIGHER_SPECIFICITY")).toBe(true);
  });

  it("detects same-scope contradictions and marks hasHardConflicts", () => {
    const rules: ScopedPolicyRule[] = [
      { id: "repo-allow", ruleKey: "XSS", scope: "REPO", action: "ALLOW", priority: 1 },
      { id: "repo-block", ruleKey: "XSS", scope: "REPO", action: "BLOCK", priority: 2 },
    ];

    const result = simulatePolicyConflicts(rules);
    expect(result.hasHardConflicts).toBe(true);
    expect(result.effectiveRules[0].effectiveRule.id).toBe("repo-block");
    expect(result.conflicts[0]).toMatchObject({
      kind: "CONFLICT_SAME_SCOPE",
      winningRuleId: "repo-block",
      losingRuleId: "repo-allow",
    });
  });

  it("ignores disabled rules and isolates distinct pathGlobs", () => {
    const rules: ScopedPolicyRule[] = [
      { id: "disabled-1", ruleKey: "SECRET", scope: "BRANCH", action: "ALLOW", enabled: false },
      { id: "src-block", ruleKey: "SECRET", scope: "REPO", action: "BLOCK", pathGlob: "src/**" },
      { id: "test-allow", ruleKey: "SECRET", scope: "REPO", action: "ALLOW", pathGlob: "tests/**" },
    ];

    const result = resolvePolicyConflicts(rules);
    expect(result.hasHardConflicts).toBe(false);
    expect(result.conflicts).toEqual([]);
    expect(result.effectiveRules).toHaveLength(2);
  });
});
