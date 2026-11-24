import { describe, it, expect, vi } from "vitest";
import {
  parseStabilityArgs,
  buildSamplePrompt,
  calculateSampleStability,
  formatStabilityMarkdownSummary,
  runStabilityEvaluation,
  type SampleRunOutcome,
  type StabilitySuiteSummary,
} from "./test-scanner-stability";
import type { PromptRegressionSample } from "../src/lib/armor/__fixtures__";

describe("Scanner Stability & Flakiness Evaluator (#2009)", () => {
  describe("parseStabilityArgs", () => {
    it("parses CLI arguments accurately with defaults", () => {
      const options = parseStabilityArgs([
        "--runs=7",
        "--threshold=85",
        "--sample=sql-injection",
        "--model=llama-3.3-70b",
        "--max-samples=3",
      ]);

      expect(options.runs).toBe(7);
      expect(options.threshold).toBe(85);
      expect(options.sampleId).toBe("sql-injection");
      expect(options.model).toBe("llama-3.3-70b");
      expect(options.maxSamples).toBe(3);
    });

    it("handles help flags", () => {
      expect(parseStabilityArgs(["--help"]).help).toBe(true);
      expect(parseStabilityArgs(["-h"]).help).toBe(true);
    });

    it("ignores invalid numeric values", () => {
      const options = parseStabilityArgs(["--runs=-5", "--threshold=150"]);
      expect(options.runs).toBeUndefined();
      expect(options.threshold).toBeUndefined();
    });
  });

  describe("buildSamplePrompt", () => {
    it("formats prompt containing filename, added lines, and policies", () => {
      const prompt = buildSamplePrompt("src/auth.ts", "@@ -0,0 +1,1 @@\n+const token = 'secret';", [
        { description: "Detect hardcoded secrets" },
      ]);

      expect(prompt).toContain('<file name="src/auth.ts" context_warning="">');
      expect(prompt).toContain("const token = 'secret';");
      expect(prompt).toContain("Detect hardcoded secrets");
      expect(prompt).toContain("CORE RULES:");
    });
  });

  describe("calculateSampleStability", () => {
    const mockSample: PromptRegressionSample = {
      id: "test-sql-injection",
      name: "Test SQL Injection",
      filename: "src/db.ts",
      code: "SELECT * FROM users;",
      patch: "@@ -0,0 +1,1 @@\n+SELECT * FROM users;",
      expected: {
        shouldDetect: true,
        category: "VULNERABILITY",
        minSeverity: "HIGH",
      },
    };

    it("computes 100% stability when all runs succeed", () => {
      const outcomes: SampleRunOutcome[] = [
        {
          runIndex: 1,
          detectedCount: 1,
          passed: true,
          actualCategories: ["VULNERABILITY"],
          actualSeverities: ["HIGH"],
          reason: "Passed",
        },
        {
          runIndex: 2,
          detectedCount: 1,
          passed: true,
          actualCategories: ["VULNERABILITY"],
          actualSeverities: ["HIGH"],
          reason: "Passed",
        },
      ];

      const result = calculateSampleStability(mockSample, outcomes, 80);
      expect(result.stabilityPercentage).toBe(100);
      expect(result.successfulRuns).toBe(2);
      expect(result.totalRuns).toBe(2);
      expect(result.passed).toBe(true);
    });

    it("identifies failing stability when rate drops below threshold", () => {
      // 3 successful, 2 failed -> 60% stability
      const outcomes: SampleRunOutcome[] = [
        {
          runIndex: 1,
          detectedCount: 1,
          passed: true,
          actualCategories: ["VULNERABILITY"],
          actualSeverities: ["HIGH"],
          reason: "Passed",
        },
        {
          runIndex: 2,
          detectedCount: 1,
          passed: true,
          actualCategories: ["VULNERABILITY"],
          actualSeverities: ["HIGH"],
          reason: "Passed",
        },
        {
          runIndex: 3,
          detectedCount: 1,
          passed: true,
          actualCategories: ["VULNERABILITY"],
          actualSeverities: ["HIGH"],
          reason: "Passed",
        },
        {
          runIndex: 4,
          detectedCount: 0,
          passed: false,
          actualCategories: [],
          actualSeverities: [],
          reason: "Missed finding",
        },
        {
          runIndex: 5,
          detectedCount: 0,
          passed: false,
          actualCategories: [],
          actualSeverities: [],
          reason: "Missed finding",
        },
      ];

      const result = calculateSampleStability(mockSample, outcomes, 80);
      expect(result.stabilityPercentage).toBe(60);
      expect(result.successfulRuns).toBe(3);
      expect(result.totalRuns).toBe(5);
      expect(result.passed).toBe(false);
    });
  });

  describe("formatStabilityMarkdownSummary", () => {
    it("renders passing markdown table when all samples meet threshold", () => {
      const summary: StabilitySuiteSummary = {
        model: "llama-3.3-70b-versatile",
        runsPerSample: 5,
        threshold: 80,
        totalSamples: 2,
        passedSamples: 2,
        failedSamples: 0,
        overallStabilityPercentage: 100,
        allPassed: true,
        results: [
          {
            sampleId: "hardcoded-secret",
            sampleName: "AWS Secret",
            filename: "src/aws.ts",
            shouldDetect: true,
            expectedCategory: "SECRET",
            totalRuns: 5,
            successfulRuns: 5,
            stabilityPercentage: 100,
            passed: true,
            outcomes: [],
          },
          {
            sampleId: "safe-sample",
            sampleName: "Safe Query",
            filename: "src/safe.ts",
            shouldDetect: false,
            totalRuns: 5,
            successfulRuns: 5,
            stabilityPercentage: 100,
            passed: true,
            outcomes: [],
          },
        ],
      };

      const md = formatStabilityMarkdownSummary(summary);
      expect(md).toContain("PASS: All samples met or exceeded stability threshold");
      expect(md).toContain("hardcoded-secret");
      expect(md).toContain("safe-sample");
      expect(md).toContain("100.0%");
    });

    it("renders failing markdown summary with failures clearly marked", () => {
      const summary: StabilitySuiteSummary = {
        model: "llama-3.3-70b-versatile",
        runsPerSample: 5,
        threshold: 80,
        totalSamples: 2,
        passedSamples: 1,
        failedSamples: 1,
        overallStabilityPercentage: 70,
        allPassed: false,
        results: [
          {
            sampleId: "flaky-sample",
            sampleName: "Flaky Finding",
            filename: "src/flaky.ts",
            shouldDetect: true,
            expectedCategory: "VULNERABILITY",
            totalRuns: 5,
            successfulRuns: 2,
            stabilityPercentage: 40,
            passed: false,
            outcomes: [
              {
                runIndex: 1,
                detectedCount: 0,
                passed: false,
                actualCategories: [],
                actualSeverities: [],
                reason: "Model missed finding",
              },
            ],
          },
        ],
      };

      const md = formatStabilityMarkdownSummary(summary);
      expect(md).toContain("FAIL: 1 of 2 samples fell below stability threshold (80%)");
      expect(md).toContain("❌ FAIL");
      expect(md).toContain("40.0%");
      expect(md).toContain("Model missed finding");
    });
  });

  describe("runStabilityEvaluation with mocked client", () => {
    it("evaluates samples against mocked Groq completions and reports stability", async () => {
      const mockCompletionsCreate = vi.fn().mockResolvedValue({
        choices: [
          {
            message: {
              content: JSON.stringify({
                findings: [
                  {
                    type: "Vulnerability",
                    severity: "HIGH",
                    description: "SQL injection flaw",
                    fileLocation: "src/db.ts",
                    codeSnippet: "query()",
                  },
                ],
              }),
            },
          },
        ],
      });

      const mockGroq: any = {
        chat: {
          completions: {
            create: mockCompletionsCreate,
          },
        },
      };

      const testSample: PromptRegressionSample = {
        id: "mock-sqli",
        name: "Mock SQL Injection",
        filename: "src/db.ts",
        code: "SELECT 1;",
        patch: "@@ -0,0 +1,1 @@\n+SELECT 1;",
        expected: {
          shouldDetect: true,
          category: "VULNERABILITY",
          minSeverity: "HIGH",
        },
      };

      const summary = await runStabilityEvaluation(
        { runs: 3, threshold: 80 },
        { groqClient: mockGroq, samples: [testSample] },
      );

      expect(mockCompletionsCreate).toHaveBeenCalledTimes(3);
      expect(summary.totalSamples).toBe(1);
      expect(summary.passedSamples).toBe(1);
      expect(summary.failedSamples).toBe(0);
      expect(summary.allPassed).toBe(true);
      expect(summary.results[0].stabilityPercentage).toBe(100);
      expect(summary.results[0].successfulRuns).toBe(3);
    });

    it("marks run as failed when model outputs empty or mismatched findings", async () => {
      // Return clean/empty findings for a positive sample
      const mockCompletionsCreate = vi.fn().mockResolvedValue({
        choices: [
          {
            message: {
              content: JSON.stringify({ findings: [] }),
            },
          },
        ],
      });

      const mockGroq: any = {
        chat: {
          completions: {
            create: mockCompletionsCreate,
          },
        },
      };

      const positiveSample: PromptRegressionSample = {
        id: "must-detect-secret",
        name: "Must Detect Secret",
        filename: "src/key.ts",
        code: "const key = 'secret';",
        patch: "@@ -0,0 +1,1 @@\n+const key = 'secret';",
        expected: {
          shouldDetect: true,
          category: "SECRET",
          minSeverity: "CRITICAL",
        },
      };

      const summary = await runStabilityEvaluation(
        { runs: 2, threshold: 90 },
        { groqClient: mockGroq, samples: [positiveSample] },
      );

      expect(summary.allPassed).toBe(false);
      expect(summary.failedSamples).toBe(1);
      expect(summary.results[0].stabilityPercentage).toBe(0);
      expect(summary.results[0].passed).toBe(false);
    });
  });
});
