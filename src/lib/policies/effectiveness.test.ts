import { describe, it, expect } from "vitest";
import {
  formatDurationMs,
  doesFindingMatchPolicy,
  calculatePolicyMetrics,
  exportPolicyMetricsToCSV,
  POLICY_NOISY_FP_RATE_THRESHOLD,
  type PolicyTemplateInput,
  type RawFindingWithTriage,
} from "./effectiveness";

describe("Policy Effectiveness Calculations (#2019)", () => {
  describe("formatDurationMs", () => {
    it("formats minutes, hours, days, and nulls properly", () => {
      expect(formatDurationMs(null)).toBe("—");
      expect(formatDurationMs(undefined)).toBe("—");
      expect(formatDurationMs(30 * 60 * 1000)).toBe("30m");
      expect(formatDurationMs(2.5 * 60 * 60 * 1000)).toBe("2.5h");
      expect(formatDurationMs(48 * 60 * 60 * 1000)).toBe("2.0d");
    });
  });

  describe("doesFindingMatchPolicy", () => {
    const sqlPolicy = {
      name: "Enforce Parameterized Queries",
      description: "Requires manual review for raw SQL queries to prevent SQL Injection",
      rules: { conditions: ["db/raw_query/*"] },
    };

    const secretPolicy = {
      name: "Block Hardcoded Secrets",
      description: "Detects secrets and tokens in source code",
      rules: { conditions: ["secrets/*"] },
    };

    it("matches finding by explanation and type", () => {
      expect(
        doesFindingMatchPolicy(
          {
            type: "VULNERABILITY",
            explanation: "Raw SQL query detected without parameterized inputs",
            fileLocation: "src/db.ts",
          },
          sqlPolicy,
        ),
      ).toBe(true);

      expect(
        doesFindingMatchPolicy(
          { type: "SECRET", explanation: "AWS Access Token found", fileLocation: "src/config.ts" },
          secretPolicy,
        ),
      ).toBe(true);
    });

    it("matches finding by rules conditions", () => {
      expect(
        doesFindingMatchPolicy(
          {
            type: "VULNERABILITY",
            explanation: "Found issue",
            fileLocation: "src/db/raw_query/user.ts",
          },
          sqlPolicy,
        ),
      ).toBe(true);
    });

    it("returns false for non-matching finding", () => {
      expect(
        doesFindingMatchPolicy(
          { type: "MISCONFIG", explanation: "Container runs as root", fileLocation: "Dockerfile" },
          sqlPolicy,
        ),
      ).toBe(false);
    });
  });

  describe("calculatePolicyMetrics", () => {
    const policies: PolicyTemplateInput[] = [
      {
        id: "pol-1",
        name: "Noisy SQL Policy",
        description: "Catches raw SQL queries",
        severity: "HIGH",
        isDefault: true,
      },
      {
        id: "pol-2",
        name: "Inactive Secret Policy",
        description: "Catches secrets and api keys",
        severity: "CRITICAL",
        isDefault: true,
      },
      {
        id: "pol-3",
        name: "Healthy SQL Injection Policy",
        description: "Catches sql injection exploits",
        severity: "CRITICAL",
        isDefault: false,
      },
    ];

    const toggles = new Map<string, boolean>([
      ["pol-1", true],
      ["pol-2", true],
      ["pol-3", true],
    ]);

    const findings: RawFindingWithTriage[] = [
      // pol-1: 4 findings, 3 false positives (75% FP) -> NOISY
      {
        id: "f-1",
        type: "VULNERABILITY",
        severity: "HIGH",
        fileLocation: "src/repo1.ts",
        explanation: "Noisy SQL Policy violation",
        fingerprint: "fp-1",
        createdAt: new Date("2026-11-01T10:00:00Z"),
        triage: {
          status: "FALSE_POSITIVE",
          dismissalReason: "FALSE_POSITIVE",
          createdAt: new Date("2026-11-01T10:00:00Z"),
          resolvedAt: null,
          updatedAt: new Date("2026-11-02T10:00:00Z"),
        },
      },
      {
        id: "f-2",
        type: "VULNERABILITY",
        severity: "HIGH",
        fileLocation: "src/repo2.ts",
        explanation: "Noisy SQL Policy violation",
        fingerprint: "fp-2",
        createdAt: new Date("2026-11-01T10:00:00Z"),
        triage: {
          status: "DISMISSED",
          dismissalReason: "FALSE_POSITIVE",
          createdAt: new Date("2026-11-01T10:00:00Z"),
          resolvedAt: null,
          updatedAt: new Date("2026-11-02T10:00:00Z"),
        },
      },
      {
        id: "f-3",
        type: "VULNERABILITY",
        severity: "HIGH",
        fileLocation: "src/repo3.ts",
        explanation: "Noisy SQL Policy violation",
        fingerprint: "fp-3",
        createdAt: new Date("2026-11-01T10:00:00Z"),
        triage: {
          status: "FALSE_POSITIVE",
          dismissalReason: null,
          createdAt: new Date("2026-11-01T10:00:00Z"),
          resolvedAt: null,
          updatedAt: new Date("2026-11-02T10:00:00Z"),
        },
      },
      {
        id: "f-4",
        type: "VULNERABILITY",
        severity: "HIGH",
        fileLocation: "src/repo4.ts",
        explanation: "Noisy SQL Policy violation",
        fingerprint: "fp-4",
        createdAt: new Date("2026-11-01T10:00:00Z"),
        triage: {
          status: "OPEN",
          dismissalReason: null,
          createdAt: new Date("2026-11-01T10:00:00Z"),
          resolvedAt: null,
          updatedAt: new Date("2026-11-01T10:00:00Z"),
        },
      },
      // pol-3: 2 findings, 2 resolved, 0 FP (0% FP) -> HEALTHY
      {
        id: "f-5",
        type: "VULNERABILITY",
        severity: "CRITICAL",
        fileLocation: "src/login.ts",
        explanation: "Healthy SQL Injection Policy match",
        fingerprint: "fp-5",
        createdAt: new Date("2026-11-01T10:00:00Z"),
        triage: {
          status: "RESOLVED",
          dismissalReason: null,
          createdAt: new Date("2026-11-01T10:00:00Z"),
          resolvedAt: new Date("2026-11-01T14:00:00Z"), // 4h duration
          updatedAt: new Date("2026-11-01T14:00:00Z"),
        },
      },
      {
        id: "f-6",
        type: "VULNERABILITY",
        severity: "CRITICAL",
        fileLocation: "src/user.ts",
        explanation: "Healthy SQL Injection Policy match",
        fingerprint: "fp-6",
        createdAt: new Date("2026-11-01T10:00:00Z"),
        triage: {
          status: "RESOLVED",
          dismissalReason: null,
          createdAt: new Date("2026-11-01T10:00:00Z"),
          resolvedAt: new Date("2026-11-01T16:00:00Z"), // 6h duration
          updatedAt: new Date("2026-11-01T16:00:00Z"),
        },
      },
    ];

    it("identifies noisy, inactive, and healthy policies correctly", () => {
      const summary = calculatePolicyMetrics(policies, toggles, findings, 30);

      expect(summary.totalPolicies).toBe(3);
      expect(summary.noisyPolicies).toBe(1);
      expect(summary.inactivePolicies).toBe(1);
      expect(summary.healthyPolicies).toBe(1);

      const noisy = summary.policies.find((p) => p.policyId === "pol-1");
      expect(noisy).toBeDefined();
      expect(noisy?.status).toBe("noisy");
      expect(noisy?.totalFindings).toBe(4);
      expect(noisy?.falsePositiveCount).toBe(3);
      expect(noisy?.falsePositiveRate).toBe(75);
      expect(noisy?.openCount).toBe(1);

      const inactive = summary.policies.find((p) => p.policyId === "pol-2");
      expect(inactive).toBeDefined();
      expect(inactive?.status).toBe("inactive");
      expect(inactive?.totalFindings).toBe(0);

      const healthy = summary.policies.find((p) => p.policyId === "pol-3");
      expect(healthy).toBeDefined();
      expect(healthy?.status).toBe("healthy");
      expect(healthy?.totalFindings).toBe(2);
      expect(healthy?.resolvedCount).toBe(2);
      expect(healthy?.resolvedRate).toBe(100);
      expect(healthy?.avgResolutionTimeFormatted).toBe("5.0h"); // (4 + 6) / 2 = 5h
    });
  });

  describe("exportPolicyMetricsToCSV with formula injection protection", () => {
    it("escapes cells starting with =, +, -, @ to prevent CSV injection attacks", () => {
      const testMetrics = [
        {
          policyId: "pol-1",
          policyName: "=CMD|' /C calc'!A0",
          description: "+Disallow dangerous exec",
          severity: "-CRITICAL",
          isActive: true,
          totalFindings: 10,
          falsePositiveCount: 6,
          falsePositiveRate: 60,
          resolvedCount: 2,
          resolvedRate: 20,
          openCount: 2,
          avgResolutionTimeMs: 3600000,
          avgResolutionTimeFormatted: "1.0h",
          status: "noisy" as const,
        },
        {
          policyId: "pol-2",
          policyName: "@SUM(1+1)",
          description: "Normal policy description",
          severity: "HIGH",
          isActive: false,
          totalFindings: 0,
          falsePositiveCount: 0,
          falsePositiveRate: 0,
          resolvedCount: 0,
          resolvedRate: 0,
          openCount: 0,
          avgResolutionTimeMs: null,
          avgResolutionTimeFormatted: "—",
          status: "inactive" as const,
        },
      ];

      const csv = exportPolicyMetricsToCSV(testMetrics);

      // Verify formula injection triggers are escaped with single quote '
      expect(csv).toContain("'=CMD|' /C calc'!A0");
      expect(csv).toContain("'+Disallow dangerous exec");
      expect(csv).toContain("'-CRITICAL");
      expect(csv).toContain("'@SUM(1+1)");

      // Verify headers
      expect(csv).toContain("Policy ID,Policy Name,Severity,Status,Active,Total Findings");
    });
  });
});
