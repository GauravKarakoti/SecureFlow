import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs";
import path from "path";
import os from "os";
import {
  computeSnippetHash,
  computeBaselineFingerprint,
  createBaselineFromResults,
  loadBaseline,
  saveBaseline,
  matchViolationAgainstBaseline,
  filterResultsWithBaseline,
  updateBaselineWithResults,
  DEFAULT_BASELINE_FILENAME,
  type BaselineFile,
} from "./baseline.js";
import { generateSarifReport, validateSarifDocument } from "./sarif.js";
import type { FileScanResult, Violation } from "./scanner.js";

describe("CLI Findings Baseline (#2060)", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "sf-baseline-test-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("computes deterministic snippet hash and fingerprint", () => {
    const hash1 = computeSnippetHash("console.log(process.env.API_KEY);");
    const hash2 = computeSnippetHash("  console.log(process.env.API_KEY);  ");
    expect(hash1).toBe(hash2);
    expect(hash1).toHaveLength(64);

    const fp1 = computeBaselineFingerprint(
      "src/index.ts",
      "process.env",
      "console.log(process.env.SECRET);",
      "SECUREFLOW-001",
    );
    const fp2 = computeBaselineFingerprint(
      "src/index.ts",
      "process.env",
      "console.log(process.env.SECRET);",
      "SECUREFLOW-001",
    );
    expect(fp1).toBe(fp2);
    expect(fp1).toHaveLength(64);
  });

  it("creates baseline document from scan results", () => {
    const mockResults: FileScanResult[] = [
      {
        path: "src/api/auth.ts",
        violations: [
          {
            line: 42,
            text: "console.log('token: ' + userToken);",
            reason: "token",
            severity: "HIGH",
          },
        ],
      },
      {
        path: "src/utils/logger.ts",
        violations: [
          {
            line: 15,
            text: "console.error(process.env.DATABASE_PASSWORD);",
            reason: "process.env",
            severity: "CRITICAL",
            ruleId: "custom-db-pass",
          },
        ],
      },
    ];

    const baseline = createBaselineFromResults(mockResults);
    expect(baseline.version).toBe(1);
    expect(baseline.violations).toHaveLength(2);

    expect(baseline.violations[0]?.path).toBe("src/api/auth.ts");
    expect(baseline.violations[0]?.line).toBe(42);
    expect(baseline.violations[0]?.reason).toBe("token");
    expect(baseline.violations[0]?.severity).toBe("HIGH");

    expect(baseline.violations[1]?.path).toBe("src/utils/logger.ts");
    expect(baseline.violations[1]?.ruleId).toBe("custom-db-pass");
    expect(baseline.violations[1]?.severity).toBe("CRITICAL");
  });

  it("saves and loads baseline file successfully", () => {
    const baseline: BaselineFile = {
      version: 1,
      generatedAt: new Date().toISOString(),
      violations: [
        {
          fingerprint: "test-fp-123",
          path: "src/auth.ts",
          line: 10,
          reason: "token",
          snippet: "console.log(token);",
          snippetHash: computeSnippetHash("console.log(token);"),
          severity: "HIGH",
        },
      ],
    };

    const targetPath = path.join(tmpDir, DEFAULT_BASELINE_FILENAME);
    const savedPath = saveBaseline(baseline, targetPath);
    expect(fs.existsSync(savedPath)).toBe(true);

    const loaded = loadBaseline(savedPath);
    expect(loaded).not.toBeNull();
    expect(loaded?.version).toBe(1);
    expect(loaded?.violations).toHaveLength(1);
    expect(loaded?.violations[0]?.fingerprint).toBe("test-fp-123");
  });

  it("returns null when loading non-existent baseline", () => {
    const loaded = loadBaseline("non-existent-baseline.json", tmpDir);
    expect(loaded).toBeNull();
  });

  it("matches violations with line-shift tolerance", () => {
    const snippet = "console.log(process.env.SECRET_TOKEN);";
    const baselineViolations = [
      {
        fingerprint: computeBaselineFingerprint("src/server.ts", "process.env", snippet),
        path: "src/server.ts",
        line: 25, // original line was 25
        reason: "process.env",
        snippet,
        snippetHash: computeSnippetHash(snippet),
        severity: "HIGH" as const,
      },
    ];

    // Shifted down to line 80 due to code edits above
    const shiftedViolation: Violation = {
      line: 80,
      text: "  console.log(process.env.SECRET_TOKEN);  ",
      reason: "process.env",
      severity: "HIGH",
    };

    const match = matchViolationAgainstBaseline(
      shiftedViolation,
      "src/server.ts",
      baselineViolations,
    );
    expect(match).not.toBeNull();
    expect(match?.path).toBe("src/server.ts");
    expect(match?.line).toBe(25);
  });

  it("filters scan results separating legacy suppressed vs new active violations", () => {
    const snippetLegacy = "console.log(legacyToken);";
    const baseline: BaselineFile = {
      version: "1.0.0",
      createdAt: new Date().toISOString(),
      generator: "secureflow-cli",
      violations: [
        {
          fingerprint: computeBaselineFingerprint("src/legacy.ts", "token", snippetLegacy),
          path: "src/legacy.ts",
          line: 12,
          reason: "token",
          snippet: snippetLegacy,
          snippetHash: computeSnippetHash(snippetLegacy),
          severity: "HIGH",
        },
      ],
    };

    const currentResults: FileScanResult[] = [
      {
        path: "src/legacy.ts",
        violations: [
          // Legacy violation
          {
            line: 14, // line shifted
            text: snippetLegacy,
            reason: "token",
            severity: "HIGH",
          },
          // Newly introduced violation
          {
            line: 55,
            text: "console.log(process.env.NEW_SECRET);",
            reason: "process.env",
            severity: "CRITICAL",
          },
        ],
      },
    ];

    const filtered = filterResultsWithBaseline(currentResults, baseline);
    expect(filtered.suppressedCount).toBe(1);
    expect(filtered.newCount).toBe(1);

    const res = filtered.results[0]!;
    expect(res.violations).toHaveLength(1);
    expect(res.violations[0]?.text).toBe("console.log(process.env.NEW_SECRET);");
    expect(res.violations[0]?.baselineState).toBe("new");

    expect(res.suppressedViolations).toBeDefined();
    expect(res.suppressedViolations).toHaveLength(1);
    expect(res.suppressedViolations?.[0]?.text).toBe(snippetLegacy);
    expect(res.suppressedViolations?.[0]?.baselineState).toBe("existing");
  });

  it("updates baseline by keeping existing, removing fixed, and adding new findings", () => {
    const existingBaseline: BaselineFile = {
      version: "1.0.0",
      createdAt: new Date().toISOString(),
      generator: "secureflow-cli",
      violations: [
        {
          fingerprint: "fp-fixed-rule",
          path: "src/fixed.ts",
          line: 10,
          reason: "old-secret",
          snippet: "console.log(oldSecret);",
          snippetHash: computeSnippetHash("console.log(oldSecret);"),
          severity: "HIGH",
        },
        {
          fingerprint: computeBaselineFingerprint(
            "src/persisted.ts",
            "token",
            "console.log(persistedToken);",
          ),
          path: "src/persisted.ts",
          line: 20,
          reason: "token",
          snippet: "console.log(persistedToken);",
          snippetHash: computeSnippetHash("console.log(persistedToken);"),
          severity: "MEDIUM",
        },
      ],
    };

    const newScanResults: FileScanResult[] = [
      {
        path: "src/persisted.ts",
        violations: [
          {
            line: 22, // line shifted
            text: "console.log(persistedToken);",
            reason: "token",
            severity: "MEDIUM",
          },
        ],
      },
      {
        path: "src/new-feature.ts",
        violations: [
          {
            line: 5,
            text: "console.log(process.env.FRESH_KEY);",
            reason: "process.env",
            severity: "HIGH",
          },
        ],
      },
    ];

    const { updatedBaseline, addedCount, removedCount } = updateBaselineWithResults(
      existingBaseline,
      newScanResults,
    );

    expect(removedCount).toBe(1); // src/fixed.ts was fixed
    expect(addedCount).toBe(1); // src/new-feature.ts was added
    expect(updatedBaseline.violations).toHaveLength(2);
    expect(updatedBaseline.violations.map((v) => v.path)).toEqual([
      "src/new-feature.ts",
      "src/persisted.ts",
    ]);
  });

  it("integrates baselineState into SARIF export and passes validation", () => {
    const scanResults: FileScanResult[] = [
      {
        path: "src/auth.ts",
        violations: [
          {
            line: 10,
            text: "console.log(process.env.NEW_KEY);",
            reason: "process.env",
            severity: "HIGH",
            baselineState: "new",
          },
        ],
        suppressedViolations: [
          {
            line: 50,
            text: "console.log(legacyToken);",
            reason: "token",
            severity: "MEDIUM",
            baselineState: "existing",
            suppression: {
              reason: "Matched baseline entry",
              line: 50,
            },
          },
        ],
      },
    ];

    const sarifDoc = generateSarifReport(scanResults);
    const validation = validateSarifDocument(sarifDoc);
    expect(validation.valid).toBe(true);

    const run = sarifDoc.runs[0]!;
    expect(run.results).toHaveLength(2);

    const newResult = run.results.find((r: any) => r.baselineState === "new");
    expect(newResult).toBeDefined();
    expect(newResult.locations[0].physicalLocation.region.startLine).toBe(10);

    const existingResult = run.results.find((r: any) => r.baselineState === "existing");
    expect(existingResult).toBeDefined();
    expect(existingResult.suppressions).toBeDefined();
    expect(existingResult.suppressions[0].justification).toBe("Matched baseline entry");
  });
});
