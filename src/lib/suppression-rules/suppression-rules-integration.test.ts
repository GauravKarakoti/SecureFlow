import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  evaluateSuppressionRules,
  type SuppressionRuleLike,
  type FindingMatchTarget,
} from "./matcher";
import { renderScanReportSummary } from "@/lib/github/scan-report";

describe("Suppression Rules Full Scan Flow Integration (#1891)", () => {
  const globalFixtureRule: SuppressionRuleLike = {
    id: "rule-global-fixture",
    name: "Suppress test fixtures",
    reason: "Test fixtures are mock files",
    scope: "ALL",
    repositoryIds: [],
    pathGlob: "fixtures/**",
  };

  const selectedSecretRule: SuppressionRuleLike = {
    id: "rule-selected-secret",
    name: "Internal tools allow secrets",
    reason: "Internal tooling repository exception",
    scope: "SELECTED",
    repositoryIds: ["repo-internal-1", "repo-internal-2"],
    matchCategory: "SECRET",
  };

  const expiringRule: SuppressionRuleLike = {
    id: "rule-expiring",
    name: "Temporary migration exception",
    reason: "Legacy system migration until 2026-11-20",
    scope: "ALL",
    repositoryIds: [],
    matchPolicy: "LegacyAuth",
    expiresAt: new Date("2026-11-20T00:00:00Z"),
  };

  it("suppresses matching findings across all repositories when scope is ALL", () => {
    const findings: FindingMatchTarget[] = [
      {
        type: "SECRET",
        severity: "CRITICAL",
        fileLocation: "fixtures/sample-key.json",
        description: "Hardcoded secret in fixture",
        fingerprint: "fp-1",
      },
      {
        type: "SECRET",
        severity: "CRITICAL",
        fileLocation: "src/auth.ts",
        description: "Real secret in production source",
        fingerprint: "fp-2",
      },
    ];

    const evalResult = evaluateSuppressionRules(
      findings,
      [globalFixtureRule],
      "any-repo-id",
    );

    expect(evalResult.suppressedCount).toBe(1);
    expect(evalResult.activeFindings).toHaveLength(1);
    expect(evalResult.activeFindings[0].fileLocation).toBe("src/auth.ts");

    expect(evalResult.suppressedFindings).toHaveLength(1);
    expect(evalResult.suppressedFindings[0].fileLocation).toBe("fixtures/sample-key.json");
    expect(evalResult.suppressedFindings[0].suppressionStatus).toBe("SUPPRESSED_BY_RULE");
    expect(evalResult.suppressedFindings[0].suppressionRuleId).toBe("rule-global-fixture");

    // PR comment reports the suppression count
    const comment = renderScanReportSummary({
      findings: evalResult.activeFindings as any,
      totalFindings: evalResult.activeFindings.length,
      inlineCount: 0,
      ruleSuppressedCount: evalResult.suppressedCount,
    });

    expect(comment).toContain("🛡️ **1** finding(s) were suppressed by installation suppression rule(s).");
  });

  it("applies SELECTED rules only to specified repositories and not others", () => {
    const finding = {
      type: "SECRET",
      severity: "HIGH",
      fileLocation: "scripts/deploy.sh",
      description: "Hardcoded token in deploy script",
      fingerprint: "fp-10",
    };

    // Scanned on internal repository -> suppressed
    const internalEval = evaluateSuppressionRules(
      [finding],
      [selectedSecretRule],
      "repo-internal-1",
    );
    expect(internalEval.suppressedCount).toBe(1);
    expect(internalEval.activeFindings).toHaveLength(0);

    // Scanned on public or different repository -> NOT suppressed
    const externalEval = evaluateSuppressionRules(
      [finding],
      [selectedSecretRule],
      "repo-public-99",
    );
    expect(externalEval.suppressedCount).toBe(0);
    expect(externalEval.activeFindings).toHaveLength(1);
  });

  it("stops applying rules after their expiry date", () => {
    const legacyFinding = {
      type: "VULNERABILITY",
      severity: "HIGH",
      fileLocation: "src/legacy/handler.ts",
      description: "LegacyAuth policy violation",
      policyName: "LegacyAuth",
      fingerprint: "fp-legacy",
    };

    // Before expiry date -> suppressed
    const beforeExpiry = new Date("2026-11-19T12:00:00Z");
    const validEval = evaluateSuppressionRules(
      [legacyFinding],
      [expiringRule],
      "repo-1",
      beforeExpiry,
    );
    expect(validEval.suppressedCount).toBe(1);

    // After expiry date -> active (not suppressed)
    const afterExpiry = new Date("2026-11-21T12:00:00Z");
    const expiredEval = evaluateSuppressionRules(
      [legacyFinding],
      [expiringRule],
      "repo-1",
      afterExpiry,
    );
    expect(expiredEval.suppressedCount).toBe(0);
    expect(expiredEval.activeFindings).toHaveLength(1);
  });
});
