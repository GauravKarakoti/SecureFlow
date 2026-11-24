import { describe, it, expect } from "vitest";
import { buildComplianceSarifDocument } from "./sarif-exporter";

describe("Compliance-Enhanced SARIF Exporter", () => {
  it("should generate a valid SARIF 2.1.0 document with compliance properties", () => {
    const findings = [
      {
        type: "SECRET",
        severity: "CRITICAL",
        fileLocation: "src/config/auth.ts",
        lineStart: 14,
        explanation: "Exposed JWT secret key",
        remediation: "Move secrets to environment variables",
        fingerprint: "fp-secret-1",
      },
      {
        type: "VULNERABILITY",
        severity: "HIGH",
        fileLocation: "src/api/query.ts",
        lineStart: 42,
        explanation: "SQL injection vulnerability (CWE-89)",
        remediation: "Use parameterized queries",
        fingerprint: "fp-sqli-1",
      },
    ];

    const sarif = buildComplianceSarifDocument(findings);

    expect(sarif.version).toBe("2.1.0");
    expect(sarif.$schema).toBe("https://json.schemastore.org/sarif-2.1.0.json");
    expect(sarif.runs).toHaveLength(1);

    const run = sarif.runs[0];
    expect(run.tool.driver.name).toBe("SecureFlow");
    expect(run.tool.driver.rules.length).toBeGreaterThanOrEqual(2);

    const secretRule = run.tool.driver.rules.find((r) => r.id.includes("SECRET"));
    expect(secretRule).toBeDefined();
    expect(secretRule?.properties.complianceTags).toContain("SOC2:CC6.1");
    expect(secretRule?.properties.complianceTags).toContain("PCI-DSS:3.4");
    expect(secretRule?.properties.tags).toContain("CWE-798");

    const vulnRule = run.tool.driver.rules.find((r) => r.id.includes("VULNERABILITY"));
    expect(vulnRule).toBeDefined();
    expect(vulnRule?.properties.tags).toContain("CWE-89");
    expect(vulnRule?.helpUri).toBe("https://cwe.mitre.org/data/definitions/89.html");

    expect(run.results).toHaveLength(2);
    expect(run.results[0].locations[0].physicalLocation.artifactLocation.uri).toBeDefined();
    expect(run.results[0].properties?.complianceTags).toBeDefined();
  });

  it("includes cryptographic fingerprints and fixes hunks (#1754)", () => {
    const findings = [
      {
        type: "SECRET",
        severity: "CRITICAL",
        fileLocation: "src/config/auth.ts",
        lineStart: 14,
        explanation: "Exposed JWT secret key",
        remediation: "process.env.JWT_SECRET",
        fingerprint: "deterministic-fp-123",
      },
    ];

    const sarif = buildComplianceSarifDocument(findings);
    const result = sarif.runs[0].results[0];

    expect(result.partialFingerprints).toBeDefined();
    expect(result.partialFingerprints?.["checksum/v1"]).toBe("deterministic-fp-123");
    expect(result.partialFingerprints?.["primaryLocationLineHash"]).toBeDefined();

    expect(result.fixes).toBeDefined();
    expect(result.fixes).toHaveLength(1);
    expect(result.fixes?.[0].artifactChanges[0].artifactLocation.uri).toBe("src/config/auth.ts");
    expect(result.fixes?.[0].artifactChanges[0].replacements[0].deletedRegion.startLine).toBe(14);
    expect(result.fixes?.[0].artifactChanges[0].replacements[0].insertedContent?.text).toBe(
      "process.env.JWT_SECRET",
    );
  });

  it("handles lineEnd, missing remediation, fallback defaults, and severity sorting", () => {
    const findings = [
      {
        type: "MISCONFIGURATION",
        severity: "LOW",
        fileLocation: "docker-compose.yml",
        lineStart: 10,
        lineEnd: 20,
        codeSnippet: "ports:\n  - 80:80",
        complianceTags: ["PCI-DSS:2.2"],
      },
      {
        type: "SECRET",
        severity: "CRITICAL",
        fileLocation: "",
        lineStart: 0,
        lineEnd: -1,
        explanation: "",
        remediation: "   ",
      },
      {
        type: "SECRET",
        severity: "CRITICAL",
        fileLocation: "server.ts",
        lineStart: 5,
        remediation: "use secret manager",
      },
    ];

    const sarif = buildComplianceSarifDocument(findings);
    const run = sarif.runs[0];

    // Sorted descending by severity (CRITICAL before LOW)
    expect(run.results).toHaveLength(3);
    const firstResult = run.results[0];
    expect(firstResult.ruleId).toBe("SECUREFLOW-SECRET-CRITICAL");

    // Line end >= lineStart included
    const lowResult = run.results.find((r) => r.ruleId === "SECUREFLOW-MISCONFIG-LOW");
    expect(lowResult?.locations[0].physicalLocation.region?.endLine).toBe(20);

    // Fallbacks: unknown location, line 1, no endLine, no fixes
    const fallbackResult = run.results.find(
      (r) => r.locations[0].physicalLocation.artifactLocation.uri === "unknown",
    );
    expect(fallbackResult).toBeDefined();
    expect(fallbackResult?.locations[0].physicalLocation.region?.startLine).toBe(1);
    expect(fallbackResult?.locations[0].physicalLocation.region?.endLine).toBeUndefined();
    expect(fallbackResult?.fixes).toBeUndefined();
  });
});
