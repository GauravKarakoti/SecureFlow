import { describe, it, expect } from "vitest";
import { generateSarifReport, computeSnippetFingerprint } from "./sarif.js";
import { getExporter } from "./exporters.js";
import { REDACTION_PLACEHOLDER } from "./secret-masker.js";
import type { FileScanResult } from "./scanner.js";

describe("Deterministic Secret Redaction Across SARIF & Exporters (#2080)", () => {
  const fakeAwsKey = ["AKIA", "IOSFODNN7EXAMPLE"].join("");
  const fakeGhToken = ["ghp_", "1234567890abcdefghijklmnopqrstuvwxyzABCD"].join("");
  const fakeJwt = [
    "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9",
    "eyJzdWIiOiIxMjM0NTY3ODkwIn0",
    "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk",
  ].join(".");

  const scanResults: FileScanResult[] = [
    {
      path: "src/config/aws.ts",
      violations: [
        {
          line: 12,
          text: `console.log("AWS Key:", "${fakeAwsKey}")`,
          reason: "Sensitive AWS key logged",
          severity: "CRITICAL",
        },
        {
          line: 25,
          text: `logger.info("GitHub PAT:", "${fakeGhToken}")`,
          reason: "Sensitive GitHub token logged",
          severity: "HIGH",
        },
      ],
    },
  ];

  it("redacts raw secrets from SARIF message.text and region.snippet.text while preserving pre-redaction fingerprints", () => {
    const sarif = generateSarifReport(scanResults, {
      aiFindings: [
        {
          id: "ai-1",
          type: "SECRET_EXPOSURE",
          severity: "HIGH",
          description: `Hardcoded JWT detected: ${fakeJwt}`,
          fileLocation: "src/auth/jwt.ts",
          lineStart: 8,
          codeSnippet: `const token = "${fakeJwt}";`,
          isZeroDay: false,
        },
      ],
    });

    const serialized = JSON.stringify(sarif);
    expect(serialized).not.toContain(fakeAwsKey);
    expect(serialized).not.toContain(fakeGhToken);
    expect(serialized).not.toContain(fakeJwt);
    expect(serialized).toContain(REDACTION_PLACEHOLDER);

    const results = sarif.runs[0]!.results;
    expect(results).toHaveLength(3);

    // Pre-redaction fingerprint stability
    const expectedAwsFp = computeSnippetFingerprint(scanResults[0]!.violations[0]!.text);
    expect(results[0]!.partialFingerprints?.["checksum/v1"]).toBe(expectedAwsFp);
    expect(results[0]!.message.text).toContain("Sensitive AWS key logged");
    expect(results[0]!.locations?.[0]?.physicalLocation?.region?.snippet?.text).toContain(
      REDACTION_PLACEHOLDER,
    );

    // AI finding redaction + pre-redaction fingerprint
    const expectedJwtFp = computeSnippetFingerprint(`const token = "${fakeJwt}";`);
    expect(results[2]!.partialFingerprints?.["checksum/v1"]).toBe(expectedJwtFp);
    expect(results[2]!.message.text).not.toContain(fakeJwt);
  });

  it("redacts secrets consistently across JSON, Markdown, CSV, and HTML exporters", () => {
    for (const format of ["json", "markdown", "csv", "html"]) {
      const output = getExporter(format).export(scanResults);
      expect(output).not.toContain(fakeAwsKey);
      expect(output).not.toContain(fakeGhToken);
      expect(output).toContain(REDACTION_PLACEHOLDER);
    }
  });
});
