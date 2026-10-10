import { describe, it, expect } from "vitest";
import {
  mapFindingToComplianceTags,
  extractCweId,
  getFrameworkFromTag,
  COMPLIANCE_CRITERIA,
} from "./taxonomy";

describe("Compliance Framework Taxonomy & Mapping Engine", () => {
  describe("CWE Extraction", () => {
    it("should extract CWE ID from various string formats", () => {
      expect(extractCweId("CWE-89")).toBe("CWE-89");
      expect(extractCweId("CWE-89: SQL Injection")).toBe("CWE-89");
      expect(extractCweId("cwe_798")).toBe("CWE-798");
      expect(extractCweId("no cwe here")).toBeNull();
    });
  });

  describe("Finding to Compliance Tag Mapping", () => {
    it("should map SECRET findings to SOC 2 CC6.1, PCI-DSS 3.4, and OWASP A02", () => {
      const tags = mapFindingToComplianceTags({
        type: "SECRET",
        severity: "CRITICAL",
        explanation: "Hardcoded Stripe API secret key exposed in source code",
      });

      expect(tags).toContain("SOC2:CC6.1");
      expect(tags).toContain("PCI-DSS:3.4");
      expect(tags).toContain("OWASP:A02:2021");
      expect(tags).toContain("ISO27001:A.8.24");
      expect(tags).toContain("NIST:SC-28");
    });

    it("should map SQL Injection findings (CWE-89) to OWASP A03, PCI-DSS 6.5, and SOC 2 CC6.6", () => {
      const tags = mapFindingToComplianceTags({
        type: "VULNERABILITY",
        severity: "CRITICAL",
        explanation: "Potential SQL Injection flaw in raw database query (CWE-89)",
        cwe: "CWE-89",
      });

      expect(tags).toContain("OWASP:A03:2021");
      expect(tags).toContain("PCI-DSS:6.5");
      expect(tags).toContain("SOC2:CC6.6");
      expect(tags).toContain("ISO27001:A.8.28");
    });

    it("should map SSRF findings to OWASP A10 and SOC 2 CC6.6", () => {
      const tags = mapFindingToComplianceTags({
        type: "VULNERABILITY",
        severity: "HIGH",
        explanation: "Server-Side Request Forgery vulnerability in webhook dispatch (CWE-918)",
      });

      expect(tags).toContain("OWASP:A10:2021");
      expect(tags).toContain("SOC2:CC6.6");
    });

    it("should map MISCONFIG findings to OWASP A05, SOC 2 CC6.6, and PCI-DSS 6.4", () => {
      const tags = mapFindingToComplianceTags({
        type: "MISCONFIG",
        severity: "MEDIUM",
        explanation: "Missing Security Headers and overly permissive CORS policy",
      });

      expect(tags).toContain("OWASP:A05:2021");
      expect(tags).toContain("SOC2:CC6.6");
      expect(tags).toContain("PCI-DSS:6.4");
    });
  });

  describe("Framework Detection", () => {
    it("should correctly resolve framework keys from compliance tags", () => {
      expect(getFrameworkFromTag("OWASP:A03:2021")).toBe("OWASP");
      expect(getFrameworkFromTag("SOC2:CC6.1")).toBe("SOC2");
      expect(getFrameworkFromTag("PCI-DSS:6.5")).toBe("PCI-DSS");
      expect(getFrameworkFromTag("HIPAA:164.312(a)(1)")).toBe("HIPAA");
      expect(getFrameworkFromTag("ISO27001:A.8.24")).toBe("ISO27001");
      expect(getFrameworkFromTag("NIST:SI-2")).toBe("NIST");
      expect(getFrameworkFromTag("UNKNOWN_TAG")).toBe("UNKNOWN");
    });

    it("should maintain valid compliance criteria descriptions", () => {
      expect(COMPLIANCE_CRITERIA["SOC2:CC6.1"]).toBeDefined();
      expect(COMPLIANCE_CRITERIA["SOC2:CC6.1"].framework).toBe("SOC2");
      expect(COMPLIANCE_CRITERIA["PCI-DSS:3.4"]).toBeDefined();
      expect(COMPLIANCE_CRITERIA["OWASP:A03:2021"]).toBeDefined();
    });
  });
});
