import { describe, it, expect } from "vitest";
import { Readable } from "node:stream";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import {
  generateSarifReport,
  formatSarifJson,
  streamSarifResults,
  parseSarifStream,
  parseSarifFileStream,
  validateSarifDocument,
  assertValidSarifDocument,
  SarifValidationError,
  type SarifDocument,
  type SarifResult,
} from "./sarif.js";
import {
  filterBySeverity,
  formatScanResults,
  type FileScanResult,
  type Severity,
} from "./scanner.js";

describe("SARIF Export Functionality for SecureFlow CLI (#728)", () => {
  const sampleScanResults: FileScanResult[] = [
    {
      path: "src/config/db.ts",
      violations: [
        {
          line: 15,
          text: 'console.log("DB Password:", process.env.DB_PASSWORD);',
          reason: "environment variable",
        },
        {
          line: 28,
          text: 'console.warn("API Token:", apiKeyToken);',
          reason: "secret-named identifier",
        },
      ],
    },
    {
      path: "src/utils/logger.ts",
      violations: [
        {
          line: 42,
          text: 'console.error("Auth:", customAuthSecret);',
          reason: "secret-named identifier",
        },
      ],
    },
    {
      path: "src/components/clean.ts",
      violations: [],
    },
  ];

  describe("generateSarifReport", () => {
    it("should generate valid SARIF v2.1.0 root structure", () => {
      const sarif = generateSarifReport(sampleScanResults);

      expect(sarif.$schema).toBe("https://json.schemastore.org/sarif-2.1.0.json");
      expect(sarif.version).toBe("2.1.0");
      expect(sarif.runs).toHaveLength(1);

      const run = sarif.runs[0];
      expect(run.tool.driver.name).toBe("SecureFlow CLI");
      expect(run.tool.driver.semanticVersion).toBe("0.1.0");
      expect(run.tool.driver.rules.length).toBeGreaterThan(0);
    });

    it("should map violations into SARIF results with correct rules and location metadata", () => {
      const sarif = generateSarifReport(sampleScanResults);
      const run = sarif.runs[0];

      expect(run.results).toHaveLength(3);

      const firstResult = run.results[0];
      expect(firstResult.ruleId).toBe("SECUREFLOW-001");
      expect(firstResult.level).toBe("error");
      expect(firstResult.message.text).toContain("process.env.DB_PASSWORD");

      const location = firstResult.locations[0].physicalLocation;
      expect(location.artifactLocation.uri).toBe("src/config/db.ts");
      expect(location.region.startLine).toBe(15);
      expect(location.region.snippet?.text).toBe(
        'console.log("DB Password:", process.env.DB_PASSWORD);',
      );
    });

    it("should handle custom tool versions in SARIF driver metadata", () => {
      const sarif = generateSarifReport(sampleScanResults, { toolVersion: "1.2.3-beta" });
      expect(sarif.runs[0].tool.driver.semanticVersion).toBe("1.2.3-beta");
    });

    it("should produce valid SARIF structure when no violations are found", () => {
      const cleanResults: FileScanResult[] = [{ path: "src/safe.ts", violations: [] }];
      const sarif = generateSarifReport(cleanResults);

      expect(sarif.runs[0].results).toHaveLength(0);
      expect(sarif.runs[0].tool.driver.rules.length).toBeGreaterThan(0);
    });

    it("should handle Windows path backslashes cleanly by converting to forward slashes", () => {
      const windowsResults: FileScanResult[] = [
        {
          path: "src\\nested\\module\\config.ts",
          violations: [
            {
              line: 10,
              text: "console.log(process.env.API_KEY)",
              reason: "environment variable",
            },
          ],
        },
      ];

      const sarif = generateSarifReport(windowsResults);
      const uri = sarif.runs[0].results[0].locations[0].physicalLocation.artifactLocation.uri;
      expect(uri).toBe("src/nested/module/config.ts");
    });
  });

  describe("SARIF Schema Validation (validateSarifDocument & assertValidSarifDocument)", () => {
    it("should successfully validate valid generated SARIF documents", () => {
      const validSarif = generateSarifReport(sampleScanResults);
      const validation = validateSarifDocument(validSarif);

      expect(validation.valid).toBe(true);
      expect(validation.errors).toHaveLength(0);
      expect(() => assertValidSarifDocument(validSarif)).not.toThrow();
    });

    it("should fail validation for non-object root documents", () => {
      expect(validateSarifDocument(null).valid).toBe(false);
      expect(validateSarifDocument(undefined).valid).toBe(false);
      expect(validateSarifDocument("not-an-object").valid).toBe(false);
      expect(validateSarifDocument([1, 2, 3]).valid).toBe(false);
    });

    it("should fail validation when $schema or version is invalid", () => {
      const invalidSchema = {
        $schema: "https://example.com/invalid.json",
        version: "2.1.0",
        runs: [],
      };
      const res1 = validateSarifDocument(invalidSchema);
      expect(res1.valid).toBe(false);
      expect(res1.errors.some((e) => e.includes("$schema"))).toBe(true);

      const invalidVersion = {
        $schema: "https://json.schemastore.org/sarif-2.1.0.json",
        version: "2.0.0",
        runs: [],
      };
      const res2 = validateSarifDocument(invalidVersion);
      expect(res2.valid).toBe(false);
      expect(res2.errors.some((e) => e.includes("version"))).toBe(true);
    });

    it("should fail validation when runs is empty or missing", () => {
      const noRuns = {
        $schema: "https://json.schemastore.org/sarif-2.1.0.json",
        version: "2.1.0",
        runs: [],
      };
      const res = validateSarifDocument(noRuns);
      expect(res.valid).toBe(false);
      expect(res.errors.some((e) => e.includes("runs"))).toBe(true);
    });

    it("should validate tool driver metadata and rule definitions", () => {
      const invalidDriver = {
        $schema: "https://json.schemastore.org/sarif-2.1.0.json",
        version: "2.1.0",
        runs: [
          {
            tool: {
              driver: {
                name: "",
                rules: [
                  {
                    id: "",
                    shortDescription: { text: "" },
                    defaultConfiguration: { level: "invalid-level" },
                  },
                ],
              },
            },
            results: [],
          },
        ],
      };

      const res = validateSarifDocument(invalidDriver);
      expect(res.valid).toBe(false);
      expect(res.errors.some((e) => e.includes("tool.driver.name"))).toBe(true);
      expect(res.errors.some((e) => e.includes("rules[0].id"))).toBe(true);
      expect(res.errors.some((e) => e.includes("shortDescription.text"))).toBe(true);
      expect(res.errors.some((e) => e.includes("defaultConfiguration.level"))).toBe(true);
    });

    it("should validate results, ruleIndex bounds, and ruleId matching", () => {
      const invalidResultSarif = {
        $schema: "https://json.schemastore.org/sarif-2.1.0.json",
        version: "2.1.0",
        runs: [
          {
            tool: {
              driver: {
                name: "SecureFlow CLI",
                rules: [
                  {
                    id: "SECUREFLOW-001",
                    shortDescription: { text: "Rule 1" },
                  },
                ],
              },
            },
            results: [
              {
                ruleId: "SECUREFLOW-002",
                ruleIndex: 0, // points to rule 0 which has ID SECUREFLOW-001 != SECUREFLOW-002
                level: "invalid-level",
                message: { text: "" },
              },
              {
                ruleId: "SECUREFLOW-001",
                ruleIndex: 5, // out of bounds
                level: "error",
                message: { text: "Some finding" },
              },
            ],
          },
        ],
      };

      const res = validateSarifDocument(invalidResultSarif);
      expect(res.valid).toBe(false);
      expect(res.errors.some((e) => e.includes("does not match result ruleId"))).toBe(true);
      expect(res.errors.some((e) => e.includes("out of bounds"))).toBe(true);
      expect(res.errors.some((e) => e.includes("level must be one of"))).toBe(true);
      expect(res.errors.some((e) => e.includes("message.text must be a non-empty string"))).toBe(
        true,
      );
    });

    it("should validate physicalLocation, URI normalization, and line numbering", () => {
      const invalidLocationSarif = {
        $schema: "https://json.schemastore.org/sarif-2.1.0.json",
        version: "2.1.0",
        runs: [
          {
            tool: {
              driver: {
                name: "SecureFlow CLI",
                rules: [{ id: "SECUREFLOW-001", shortDescription: { text: "Rule 1" } }],
              },
            },
            results: [
              {
                ruleId: "SECUREFLOW-001",
                ruleIndex: 0,
                level: "error",
                message: { text: "Secret detected" },
                locations: [
                  {
                    physicalLocation: {
                      artifactLocation: { uri: "src\\windows\\path.ts" }, // unescaped backslash
                      region: {
                        startLine: 0, // must be >= 1
                        endLine: -5,
                      },
                    },
                  },
                ],
              },
            ],
          },
        ],
      };

      const res = validateSarifDocument(invalidLocationSarif);
      expect(res.valid).toBe(false);
      expect(res.errors.some((e) => e.includes("forward slashes"))).toBe(true);
      expect(res.errors.some((e) => e.includes("startLine must be an integer >= 1"))).toBe(true);
      expect(res.errors.some((e) => e.includes("endLine must be an integer >= startLine"))).toBe(
        true,
      );
    });

    it("should throw SarifValidationError with error details when assertValidSarifDocument fails", () => {
      const badDoc = { $schema: "", version: "1.0", runs: [] };
      expect(() => assertValidSarifDocument(badDoc)).toThrow(SarifValidationError);

      try {
        assertValidSarifDocument(badDoc);
      } catch (err) {
        expect(err).toBeInstanceOf(SarifValidationError);
        const sarifErr = err as SarifValidationError;
        expect(sarifErr.name).toBe("SarifValidationError");
        expect(sarifErr.errors.length).toBeGreaterThan(0);
        expect(sarifErr.message).toContain("SARIF schema validation failed");
      }
    });
  });

  describe("formatSarifJson & formatScanResults", () => {
    it("should return pretty JSON formatted SARIF string", () => {
      const jsonString = formatSarifJson(sampleScanResults);
      expect(jsonString).toContain('"version": "2.1.0"');
      expect(jsonString).toContain('"SecureFlow CLI"');
      expect(() => JSON.parse(jsonString)).not.toThrow();
    });

    it("should output SARIF format via formatScanResults", () => {
      const sarifOutput = formatScanResults(sampleScanResults, "sarif");
      const parsed = JSON.parse(sarifOutput);
      expect(parsed.$schema).toContain("sarif");
      expect(parsed.runs[0].results.length).toBe(3);
    });

    it("should output JSON format via formatScanResults", () => {
      const jsonOutput = formatScanResults(sampleScanResults, "json");
      const parsed = JSON.parse(jsonOutput);
      expect(Array.isArray(parsed)).toBe(true);
      expect(parsed.length).toBe(3);
    });

    it("should output text summary via formatScanResults", () => {
      const textOutput = formatScanResults(sampleScanResults, "text");
      expect(textOutput).toContain("🚨 [SecureFlow] Secret logging detected");
      expect(textOutput).toContain("src/config/db.ts:15");
    });

    it("should output CSV format via formatScanResults", () => {
      const csvOutput = formatScanResults(sampleScanResults, "csv");
      expect(csvOutput).toContain("File,Line,Violation,Reason");
      expect(csvOutput).toContain("src/config/db.ts");
      expect(csvOutput).toContain("environment variable");
      const lines = csvOutput.trimEnd().split("\n");
      // 1 header + 3 violations
      expect(lines).toHaveLength(4);
    });

    it("should output HTML format via formatScanResults", () => {
      const htmlOutput = formatScanResults(sampleScanResults, "html");
      expect(htmlOutput).toContain("<!DOCTYPE html>");
      expect(htmlOutput).toContain("SecureFlow Scan Report");
      expect(htmlOutput).toContain("src/config/db.ts");
      expect(htmlOutput).toContain("3 violations found.");
    });
  });

  describe("severity filtering with SARIF output", () => {
    it("should pass through all unlabeled violations regardless of filter", () => {
      const filtered = filterBySeverity(sampleScanResults, new Set(["CRITICAL" as Severity]));
      const sarif = generateSarifReport(filtered);
      expect(sarif.runs[0].results).toHaveLength(3);
    });

    it("should filter labeled violations before SARIF generation", () => {
      const labeledResults: FileScanResult[] = [
        {
          path: "src/a.ts",
          violations: [
            {
              line: 1,
              text: "console.log(process.env.X)",
              reason: "environment variable",
              severity: "CRITICAL",
            },
            {
              line: 5,
              text: "console.log(token)",
              reason: "secret-named identifier",
              severity: "HIGH",
            },
          ],
        },
      ];
      const filtered = filterBySeverity(labeledResults, new Set(["CRITICAL" as Severity]));
      const sarif = generateSarifReport(filtered);
      expect(sarif.runs[0].results).toHaveLength(1);
    });

    it("should produce empty SARIF results when all labeled violations are filtered out", () => {
      const labeledResults: FileScanResult[] = [
        {
          path: "src/a.ts",
          violations: [
            {
              line: 1,
              text: "console.log(token)",
              reason: "secret-named identifier",
              severity: "HIGH",
            },
          ],
        },
      ];
      const filtered = filterBySeverity(labeledResults, new Set(["LOW" as Severity]));
      const sarif = generateSarifReport(filtered);
      expect(sarif.runs[0].results).toHaveLength(0);
    });
  });

  describe("Streaming JSON Parser for Large SARIF Reports (#1232)", () => {
    it("should stream and extract individual SarifResult records iteratively", async () => {
      const sarifDoc = generateSarifReport(sampleScanResults);
      const jsonContent = JSON.stringify(sarifDoc);
      const stream = Readable.from([jsonContent]);

      const results: SarifResult[] = [];
      for await (const result of streamSarifResults(stream)) {
        results.push(result);
      }

      expect(results).toHaveLength(3);
      expect(results[0].ruleId).toBe("SECUREFLOW-001");
      expect(results[0].message.text).toContain("process.env.DB_PASSWORD");
      expect(results[1].ruleId).toBe("SECUREFLOW-002");
      expect(results[2].ruleId).toBe("SECUREFLOW-002");
    });

    it("should process results via parseSarifStream callback without buffering", async () => {
      const sarifDoc = generateSarifReport(sampleScanResults);
      const jsonContent = JSON.stringify(sarifDoc);
      const stream = Readable.from([jsonContent]);

      const received: string[] = [];
      const summary = await parseSarifStream(stream, (result) => {
        received.push(result.ruleId);
      });

      expect(summary.totalResults).toBe(3);
      expect(received).toEqual(["SECUREFLOW-001", "SECUREFLOW-002", "SECUREFLOW-002"]);
    });

    it("should stream directly from file path via parseSarifFileStream using fs.createReadStream", async () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "sarif-stream-test-"));
      const filePath = path.join(tmpDir, "report.sarif");

      try {
        const sarifDoc = generateSarifReport(sampleScanResults);
        fs.writeFileSync(filePath, JSON.stringify(sarifDoc, null, 2), "utf-8");

        const parsed = await parseSarifFileStream(filePath);
        expect(parsed.totalResults).toBe(3);
        expect(parsed.results[0].locations[0].physicalLocation.artifactLocation.uri).toBe(
          "src/config/db.ts",
        );
      } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
    });

    it("should handle empty results array gracefully", async () => {
      const emptySarif = {
        $schema: "https://json.schemastore.org/sarif-2.1.0.json",
        version: "2.1.0",
        runs: [{ tool: { driver: { name: "Test" } }, results: [] }],
      };
      const stream = Readable.from([JSON.stringify(emptySarif)]);

      const results: SarifResult[] = [];
      for await (const result of streamSarifResults(stream)) {
        results.push(result);
      }

      expect(results).toHaveLength(0);
    });

    it("should maintain flat memory consumption (< 150MB) while streaming large synthetic SARIF data", async () => {
      // Stream a synthetic large SARIF report (10,000 results)
      const totalItems = 10000;

      async function* generateSyntheticSarif() {
        yield '{"version":"2.1.0","runs":[{"tool":{"driver":{"name":"BigScan"}},"results":[';
        for (let i = 1; i <= totalItems; i++) {
          yield `${i === 1 ? "" : ","}{"ruleId":"RULE-${i}","level":"error","message":{"text":"Vulnerability report for item ${i} with extended description to simulate payload"},"locations":[{"physicalLocation":{"artifactLocation":{"uri":"repo/deeply/nested/component_${i}.tsx"},"region":{"startLine":${i},"snippet":{"text":"leak_${i}"}}}}]}`;
        }
        yield "]}]}";
      }

      const stream = Readable.from(generateSyntheticSarif());

      let parsedCount = 0;
      let maxHeapMb = 0;

      for await (const result of streamSarifResults(stream)) {
        parsedCount++;
        if (parsedCount % 2000 === 0) {
          const heapMb = process.memoryUsage().heapUsed / (1024 * 1024);
          if (heapMb > maxHeapMb) maxHeapMb = heapMb;
        }
      }

      expect(parsedCount).toBe(totalItems);
      // Verify acceptance criteria: memory consumption stays well under 150MB
      expect(maxHeapMb).toBeLessThan(150);
    });
  });
});
