import { describe, expect, it } from "vitest";
import { importSarifFindings, normalizeSarifSeverity, parseSarifLog } from "./sarif-importer";

describe("SARIF 2.1.0 Importer & Normalizer", () => {
  it("normalizes SARIF levels and CVSS security-severity scores", () => {
    expect(normalizeSarifSeverity("warning", "9.8")).toBe("CRITICAL");
    expect(normalizeSarifSeverity("warning", 7.5)).toBe("HIGH");
    expect(normalizeSarifSeverity("error")).toBe("HIGH");
    expect(normalizeSarifSeverity("warning")).toBe("MEDIUM");
    expect(normalizeSarifSeverity("note")).toBe("LOW");
    expect(normalizeSarifSeverity("none")).toBe("INFO");
  });

  it("parses multi-run SARIF 2.1.0 logs, extracts CWEs, and deduplicates across tools", () => {
    const sarif = {
      $schema: "https://json.schemastore.org/sarif-2.1.0.json",
      version: "2.1.0",
      runs: [
        {
          tool: {
            driver: {
              name: "Semgrep",
              version: "1.90.0",
              rules: [
                {
                  id: "javascript.lang.security.audit.sqli",
                  shortDescription: { text: "SQL Injection via template literal" },
                  helpUri: "https://cwe.mitre.org/data/definitions/89.html",
                  properties: {
                    tags: ["security", "external/cwe/cwe-89"],
                    "security-severity": "9.1",
                  },
                },
              ],
            },
          },
          results: [
            {
              ruleId: "javascript.lang.security.audit.sqli",
              level: "error" as const,
              message: { text: "Unsanitized user input flows into SQL query." },
              partialFingerprints: { primaryLocationLineHash: "fp-sqli-1" },
              locations: [
                {
                  physicalLocation: {
                    artifactLocation: { uri: "file://./src/api/users.ts" },
                    region: { startLine: 42, endLine: 44 },
                  },
                },
              ],
            },
          ],
        },
        {
          tool: {
            driver: {
              name: "CodeQL",
              version: "2.18.0",
              rules: [],
            },
          },
          results: [
            {
              ruleId: "javascript.lang.security.audit.sqli",
              level: "error" as const,
              message: { text: "Unsanitized user input flows into SQL query." },
              partialFingerprints: { primaryLocationLineHash: "fp-sqli-1" },
              locations: [
                {
                  physicalLocation: {
                    artifactLocation: { uri: "src/api/users.ts" },
                    region: { startLine: 42, endLine: 44 },
                  },
                },
              ],
            },
            {
              ruleId: "js/xss",
              level: "warning" as const,
              message: { text: "Reflected XSS in response." },
              locations: [
                {
                  physicalLocation: {
                    artifactLocation: { uri: "src/ui/render.tsx" },
                    region: { startLine: 15 },
                  },
                },
              ],
            },
          ],
        },
      ],
    };

    const result = parseSarifLog(JSON.stringify(sarif));
    expect(result.valid).toBe(true);
    expect(result.toolDrivers).toHaveLength(2);
    expect(result.deduplicatedCount).toBe(1);
    expect(result.findings).toHaveLength(2);

    const sqli = result.findings[0];
    expect(sqli.severity).toBe("CRITICAL");
    expect(sqli.cwe).toBe("CWE-89");
    expect(sqli.fileLocation).toBe("src/api/users.ts");
    expect(sqli.lineStart).toBe(42);
    expect(sqli.lineEnd).toBe(44);
    expect(sqli.sourceTools).toEqual(["Semgrep", "CodeQL"]);

    const xss = result.findings[1];
    expect(xss.severity).toBe("MEDIUM");
    expect(xss.fingerprint).toHaveLength(32);
  });

  it("rejects malformed JSON and unsupported SARIF versions", () => {
    const badJson = parseSarifLog("{not-valid");
    expect(badJson.valid).toBe(false);
    expect(badJson.errors[0]).toContain("Invalid JSON");

    const badVersion = parseSarifLog({ version: "1.0.0", runs: [] });
    expect(badVersion.valid).toBe(false);
    expect(badVersion.errors[0]).toContain("2.1.0");

    expect(() => importSarifFindings({ version: "1.0.0", runs: [] })).toThrow(
      /SARIF import failed/,
    );
  });
});
