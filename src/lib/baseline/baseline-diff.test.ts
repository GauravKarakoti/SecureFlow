import { describe, expect, it } from "vitest";
import { evaluateBaselineDiff, type BaselineFindingLike } from "./baseline-diff";
import { evaluatePullRequestAgainstBaseline } from "./baseline-scanner";

describe("Baseline Diff & Regression Gate Evaluator (#2226)", () => {
  const baseline: BaselineFindingLike[] = [
    {
      fingerprint: "fp-1",
      type: "XSS",
      severity: "MEDIUM",
      fileLocation: "src/ui/page.tsx",
      lineStart: 12,
    },
    {
      fingerprint: "fp-2",
      type: "SECRET",
      severity: "HIGH",
      fileLocation: "src/config.ts",
      lineStart: 4,
    },
  ];

  it("classifies NEW, PERSISTENT, RESOLVED, and SEVERITY_ESCALATED findings accurately", () => {
    const current: BaselineFindingLike[] = [
      {
        fingerprint: "fp-1",
        type: "XSS",
        severity: "HIGH", // Escalated from MEDIUM -> HIGH
        fileLocation: "src/ui/page.tsx",
        lineStart: 12,
      },
      {
        fingerprint: "fp-3",
        type: "SQL_INJECTION",
        severity: "CRITICAL", // New CRITICAL
        fileLocation: "src/api/users.ts",
        lineStart: 30,
      },
    ];

    const diff = evaluateBaselineDiff(baseline, current);
    expect(diff.verdict).toBe("BLOCK");
    expect(diff.summary).toEqual({
      baselineTotal: 2,
      currentTotal: 2,
      newCount: 1,
      persistentCount: 0,
      resolvedCount: 1,
      escalatedCount: 1,
      newCriticalCount: 1,
      newHighCount: 0,
    });
    expect(diff.resolvedFindings[0].fingerprint).toBe("fp-2");
    expect(diff.escalatedFindings[0]).toMatchObject({
      previousSeverity: "MEDIUM",
      currentSeverity: "HIGH",
    });
    expect(diff.blockReasons).toHaveLength(2);
  });

  it("passes when only persistent or resolved findings exist", () => {
    const current: BaselineFindingLike[] = [
      {
        fingerprint: "fp-1",
        type: "XSS",
        severity: "MEDIUM",
        fileLocation: "src/ui/page.tsx",
        lineStart: 12,
      },
    ];

    const diff = evaluatePullRequestAgainstBaseline(baseline, current);
    expect(diff.verdict).toBe("PASS");
    expect(diff.blockReasons).toEqual([]);
    expect(diff.persistentFindings).toHaveLength(1);
    expect(diff.resolvedFindings).toHaveLength(1);
    expect(diff.netDelta).toBe(-1);
  });

  it("falls back to normalized location identity when fingerprint is absent", () => {
    const baseNoFp: BaselineFindingLike[] = [
      { type: "MISCONFIG", severity: "LOW", fileLocation: "./src\\app.ts", lineStart: 9 },
    ];
    const currNoFp: BaselineFindingLike[] = [
      { type: "misconfig", severity: "LOW", fileLocation: "src/app.ts", lineStart: 9 },
    ];

    const diff = evaluateBaselineDiff(baseNoFp, currNoFp);
    expect(diff.verdict).toBe("PASS");
    expect(diff.persistentFindings).toHaveLength(1);
    expect(diff.newFindings).toHaveLength(0);
  });
});
