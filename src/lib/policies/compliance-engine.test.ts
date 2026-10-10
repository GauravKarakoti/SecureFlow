import { describe, it, expect } from "vitest";
import {
  evaluateCompliancePolicies,
  enrichFindingsWithComplianceTags,
} from "./compliance-engine";
import {
  SOC2_BASELINE_PACK,
  PCI_DSS_PAYMENT_PACK,
  OWASP_TOP10_PACK,
  DEFAULT_COMPLIANCE_PACKS,
} from "./compliance-packs";

describe("Compliance Policy Evaluation Engine", () => {
  it("should return PASS when there are no findings", () => {
    const result = evaluateCompliancePolicies([]);

    expect(result.decision).toBe("PASS");
    expect(result.isCompliant).toBe(true);
    expect(result.blockedFindingsCount).toBe(0);
    expect(result.frameworks.SOC2.status).toBe("PASS");
    expect(result.frameworks.OWASP.status).toBe("PASS");
  });

  it("should BLOCK a PR when a CRITICAL secret violates SOC 2 CC6.1 baseline", () => {
    const findings = [
      {
        type: "SECRET",
        severity: "CRITICAL",
        explanation: "Exposed AWS Production Secret Key in code",
      },
    ];

    const result = evaluateCompliancePolicies(findings, [SOC2_BASELINE_PACK]);

    expect(result.decision).toBe("BLOCKED");
    expect(result.isCompliant).toBe(false);
    expect(result.blockedFindingsCount).toBe(1);
    expect(result.blockedPacks).toContain("SOC 2 Type II Security Baseline");
    expect(result.violatedTags).toContain("SOC2:CC6.1");
    expect(result.frameworks.SOC2.status).toBe("FAIL");
    expect(result.frameworks.SOC2.criticalViolations).toBe(1);
  });

  it("should BLOCK a PR with SQL Injection violating PCI-DSS 6.5 and OWASP A03", () => {
    const findings = [
      {
        type: "VULNERABILITY",
        severity: "CRITICAL",
        explanation: "Raw unescaped SQL statement in credit card processing endpoint (CWE-89)",
      },
    ];

    const result = evaluateCompliancePolicies(findings, [PCI_DSS_PAYMENT_PACK, OWASP_TOP10_PACK]);

    expect(result.decision).toBe("BLOCKED");
    expect(result.isCompliant).toBe(false);
    expect(result.frameworks["PCI-DSS"].status).toBe("FAIL");
    expect(result.frameworks.OWASP.status).toBe("FAIL");
  });

  it("should set REVIEW REQUIRED for medium misconfigurations", () => {
    const findings = [
      {
        type: "MISCONFIG",
        severity: "MEDIUM",
        explanation: "Missing Content-Security-Policy header",
      },
    ];

    const result = evaluateCompliancePolicies(findings, DEFAULT_COMPLIANCE_PACKS);

    expect(result.decision).toBe("REVIEW REQUIRED");
    expect(result.isCompliant).toBe(false);
    expect(result.blockedFindingsCount).toBe(0);
    expect(result.frameworks.OWASP.status).toBe("WARN");
  });

  it("should enrich findings with complianceTags if missing", () => {
    const findings = [
      {
        type: "SECRET",
        severity: "HIGH",
        explanation: "GitHub Personal Access Token hardcoded",
      },
    ];

    const enriched = enrichFindingsWithComplianceTags(findings);
    expect(enriched[0].complianceTags).toBeDefined();
    expect(enriched[0].complianceTags.length).toBeGreaterThan(0);
    expect(enriched[0].complianceTags).toContain("SOC2:CC6.1");
  });
});
