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

    expect(run.results).toHaveLength(2);
    expect(run.results[0].locations[0].physicalLocation.artifactLocation.uri).toBeDefined();
    expect(run.results[0].properties?.complianceTags).toBeDefined();
  });
});
