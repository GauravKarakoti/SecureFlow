import { describe, it, expect } from "vitest";
import {
  isRuleActive,
  isRuleInScope,
  matchesSuppressionRule,
  evaluateSuppressionRules,
  type SuppressionRuleLike,
  type FindingMatchTarget,
} from "./matcher";

describe("Suppression Rules Matcher (#1891)", () => {
  const baseRule: SuppressionRuleLike = {
    id: "rule-1",
    name: "Ignore test fixtures",
    reason: "Test fixtures contain intentional dummy tokens",
    scope: "ALL",
    repositoryIds: [],
    pathGlob: "fixtures/**",
  };

  const sampleFinding: FindingMatchTarget = {
    type: "SECRET",
    severity: "HIGH",
    fileLocation: "fixtures/dummy-secret.json",
    description: "Detected hardcoded AWS access key",
  };

  describe("isRuleActive (expiry checks)", () => {
    it("returns true when rule has no expiry date", () => {
      expect(isRuleActive({ ...baseRule, expiresAt: null })).toBe(true);
      expect(isRuleActive({ ...baseRule, expiresAt: undefined })).toBe(true);
    });

    it("returns true when expiry date is in the future", () => {
      const future = new Date(Date.now() + 86400 * 1000 * 7); // 7 days ahead
      expect(isRuleActive({ ...baseRule, expiresAt: future })).toBe(true);
    });

    it("returns false when expiry date is in the past (stops applying after date)", () => {
      const past = new Date(Date.now() - 86400 * 1000); // 1 day ago
      expect(isRuleActive({ ...baseRule, expiresAt: past })).toBe(false);
    });
  });

  describe("isRuleInScope (repository scope checks)", () => {
    it("applies to any repository when scope is ALL", () => {
      expect(isRuleInScope({ ...baseRule, scope: "ALL" }, "repo-123")).toBe(true);
      expect(isRuleInScope({ ...baseRule, scope: "ALL" }, null)).toBe(true);
    });

    it("applies only to listed repositories when scope is SELECTED", () => {
      const selectedRule: SuppressionRuleLike = {
        ...baseRule,
        scope: "SELECTED",
        repositoryIds: ["repo-1", "repo-2"],
      };

      expect(isRuleInScope(selectedRule, "repo-1")).toBe(true);
      expect(isRuleInScope(selectedRule, "repo-2")).toBe(true);
      expect(isRuleInScope(selectedRule, "repo-3")).toBe(false);
      expect(isRuleInScope(selectedRule, null)).toBe(false);
    });
  });

  describe("matchesSuppressionRule (path matching and category)", () => {
    it("matches finding by path glob", () => {
      expect(
        matchesSuppressionRule({ ...sampleFinding, fileLocation: "fixtures/token.js" }, baseRule),
      ).toBe(true);

      expect(
        matchesSuppressionRule({ ...sampleFinding, fileLocation: "src/index.ts" }, baseRule),
      ).toBe(false);
    });

    it("matches finding by category", () => {
      const categoryRule: SuppressionRuleLike = {
        ...baseRule,
        pathGlob: null,
        matchCategory: "SECRET",
      };

      expect(matchesSuppressionRule({ ...sampleFinding, type: "SECRET" }, categoryRule)).toBe(true);

      expect(
        matchesSuppressionRule({ ...sampleFinding, type: "VULNERABILITY" }, categoryRule),
      ).toBe(false);
    });

    it("matches finding by policy name", () => {
      const policyRule: SuppressionRuleLike = {
        ...baseRule,
        pathGlob: null,
        matchPolicy: "AWS",
      };

      expect(
        matchesSuppressionRule(
          { ...sampleFinding, description: "Hardcoded AWS secret" },
          policyRule,
        ),
      ).toBe(true);

      expect(
        matchesSuppressionRule(
          { ...sampleFinding, description: "SQL Injection vector" },
          policyRule,
        ),
      ).toBe(false);
    });

    it("requires all configured criteria to match (conjunction)", () => {
      const strictRule: SuppressionRuleLike = {
        ...baseRule,
        pathGlob: "test/**",
        matchCategory: "SECRET",
      };

      // Both match
      expect(
        matchesSuppressionRule(
          { ...sampleFinding, fileLocation: "test/secret.ts", type: "SECRET" },
          strictRule,
        ),
      ).toBe(true);

      // Path matches but category doesn't
      expect(
        matchesSuppressionRule(
          { ...sampleFinding, fileLocation: "test/secret.ts", type: "MISCONFIG" },
          strictRule,
        ),
      ).toBe(false);

      // Category matches but path doesn't
      expect(
        matchesSuppressionRule(
          { ...sampleFinding, fileLocation: "src/secret.ts", type: "SECRET" },
          strictRule,
        ),
      ).toBe(false);
    });
  });

  describe("evaluateSuppressionRules", () => {
    it("marks matches as SUPPRESSED_BY_RULE with the rule ID", () => {
      const findings: FindingMatchTarget[] = [
        {
          type: "SECRET",
          fileLocation: "fixtures/mock.ts",
          fingerprint: "fp-1",
        },
        {
          type: "SECRET",
          fileLocation: "src/app.ts",
          fingerprint: "fp-2",
        },
      ];

      const result = evaluateSuppressionRules(findings, [baseRule], "repo-abc");

      expect(result.suppressedCount).toBe(1);
      expect(result.activeFindings).toHaveLength(1);
      expect(result.activeFindings[0].fileLocation).toBe("src/app.ts");

      expect(result.suppressedFindings).toHaveLength(1);
      expect(result.suppressedFindings[0].fileLocation).toBe("fixtures/mock.ts");
      expect(result.suppressedFindings[0].suppressionStatus).toBe("SUPPRESSED_BY_RULE");
      expect(result.suppressedFindings[0].suppressionRuleId).toBe("rule-1");
      expect(result.ruleMatches).toHaveLength(1);
      expect(result.ruleMatches[0].rule.id).toBe("rule-1");
    });

    it("does not suppress findings when rule has expired", () => {
      const expiredRule: SuppressionRuleLike = {
        ...baseRule,
        expiresAt: new Date(Date.now() - 60000), // expired 1 minute ago
      };

      const findings: FindingMatchTarget[] = [
        {
          type: "SECRET",
          fileLocation: "fixtures/mock.ts",
          fingerprint: "fp-1",
        },
      ];

      const result = evaluateSuppressionRules(findings, [expiredRule], "repo-abc");

      expect(result.suppressedCount).toBe(0);
      expect(result.activeFindings).toHaveLength(1);
      expect(result.suppressedFindings).toHaveLength(0);
    });

    it("respects repository scope restrictions", () => {
      const scopedRule: SuppressionRuleLike = {
        ...baseRule,
        scope: "SELECTED",
        repositoryIds: ["repo-allowed"],
      };

      const findings: FindingMatchTarget[] = [
        {
          type: "SECRET",
          fileLocation: "fixtures/mock.ts",
          fingerprint: "fp-1",
        },
      ];

      // Scanned on disallowed repo -> not suppressed
      const resOther = evaluateSuppressionRules(findings, [scopedRule], "repo-other");
      expect(resOther.suppressedCount).toBe(0);
      expect(resOther.activeFindings).toHaveLength(1);

      // Scanned on allowed repo -> suppressed
      const resAllowed = evaluateSuppressionRules(findings, [scopedRule], "repo-allowed");
      expect(resAllowed.suppressedCount).toBe(1);
      expect(resAllowed.suppressedFindings[0].suppressionStatus).toBe("SUPPRESSED_BY_RULE");
    });
  });
});
