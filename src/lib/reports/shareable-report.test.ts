import { describe, it, expect } from "vitest";
import {
  calculateHeistRiskScore,
  calculateVaultIntegrity,
  deriveDistribution,
  escapeHtml,
  generateShareableReportHtml,
  type ShareableReportFinding,
} from "./shareable-report";

describe("Shareable Security Report & Themed Metrics", () => {
  describe("escapeHtml", () => {
    it("escapes special HTML characters properly", () => {
      expect(escapeHtml("<script>alert('xss')</script>")).toBe(
        "&lt;script&gt;alert(&#039;xss&#039;)&lt;/script&gt;",
      );
      expect(escapeHtml('Hello "World" & Team')).toBe("Hello &quot;World&quot; &amp; Team");
    });

    it("handles null or undefined gracefully", () => {
      expect(escapeHtml(null)).toBe("");
      expect(escapeHtml(undefined)).toBe("");
    });
  });

  describe("calculateHeistRiskScore", () => {
    it("returns zero minimal risk when no findings are present", () => {
      const result = calculateHeistRiskScore({});
      expect(result.score).toBe(0);
      expect(result.level).toBe("MINIMAL");
      expect(result.badge).toBe("PERIMETER SECURE");
      expect(result.color).toBe("#10B981");
    });

    it("calculates score using weighted penalties and caps at 100", () => {
      // 1 critical (25) + 2 high (20) + 1 medium (3) + 2 low (2) = 50
      const result = calculateHeistRiskScore({
        critical: 1,
        high: 2,
        medium: 1,
        low: 2,
      });
      expect(result.score).toBe(50);
      expect(result.level).toBe("ELEVATED");
      expect(result.badge).toBe("PERIMETER THREAT");

      // Capped at 100
      const breach = calculateHeistRiskScore({ critical: 5 });
      expect(breach.score).toBe(100);
      expect(breach.level).toBe("CRITICAL BREACH");
      expect(breach.badge).toBe("VAULT COMPROMISED");
      expect(breach.color).toBe("#EF4444");
    });

    it("assigns Guarded Risk for scores between 25 and 49", () => {
      const result = calculateHeistRiskScore({ critical: 1, high: 1 }); // 35
      expect(result.score).toBe(35);
      expect(result.level).toBe("GUARDED");
      expect(result.badge).toBe("MONITORING ACTIVE");
    });
  });

  describe("calculateVaultIntegrity", () => {
    it("returns FORTIFIED (100%) when perimeter is clean", () => {
      const result = calculateVaultIntegrity({});
      expect(result.percentage).toBe(100);
      expect(result.status).toBe("FORTIFIED");
      expect(result.color).toBe("#0A5C3E");
      expect(result.accentColor).toBe("#10B981");
    });

    it("calculates integrity based on passRate if provided", () => {
      const fortified = calculateVaultIntegrity({ passRate: 95 });
      expect(fortified.status).toBe("FORTIFIED");
      expect(fortified.percentage).toBe(95);

      const secured = calculateVaultIntegrity({ passRate: 80 });
      expect(secured.status).toBe("SECURED");
      expect(secured.percentage).toBe(80);

      const guarded = calculateVaultIntegrity({ passRate: 65 });
      expect(guarded.status).toBe("GUARDED");

      const compromised = calculateVaultIntegrity({ passRate: 30 });
      expect(compromised.status).toBe("COMPROMISED");
    });

    it("reduces integrity according to finding severity penalties", () => {
      // critical * 20 (60) + high * 8 (16) = 76 deduction -> 24%
      const result = calculateVaultIntegrity({ critical: 3, high: 2 });
      expect(result.percentage).toBe(24);
      expect(result.status).toBe("COMPROMISED");
    });
  });

  describe("deriveDistribution", () => {
    it("aggregates severity counts accurately", () => {
      const findings: ShareableReportFinding[] = [
        { id: "1", severity: "CRITICAL", type: "SECRET", fileLocation: "a.ts", status: "OPEN" },
        { id: "2", severity: "HIGH", type: "VULN", fileLocation: "b.ts", status: "OPEN" },
        { id: "3", severity: "MEDIUM", type: "MISCONFIG", fileLocation: "c.ts", status: "OPEN" },
        { id: "4", severity: "LOW", type: "OTHER", fileLocation: "d.ts", status: "OPEN" },
        { id: "5", severity: "critical", type: "SECRET", fileLocation: "e.ts", status: "OPEN" },
      ];

      const dist = deriveDistribution(findings);
      expect(dist).toEqual({ critical: 2, high: 1, medium: 1, low: 1 });
    });
  });

  describe("generateShareableReportHtml", () => {
    it("renders empty state report when no findings are supplied", () => {
      const html = generateShareableReportHtml({
        findings: [],
        reportId: "SEC-TEST-001",
      });

      expect(html).toContain("SEC-TEST-001");
      expect(html).toContain("Heist Risk Score");
      expect(html).toContain("Vault Integrity Status");
      expect(html).toContain("FORTIFIED");
      expect(html).toContain("#5A29E4"); // Electric Royal Violet
      expect(html).toContain("#0A5C3E"); // Deep Vault Emerald
      expect(html).toContain("Vault Perimeter Unbroken");
      expect(html).toContain("window.print()");
    });

    it("renders dark-mode card layout for findings with Professor's directive", () => {
      const findings: ShareableReportFinding[] = [
        {
          id: "find-01",
          severity: "CRITICAL",
          type: "AWS_SECRET_KEY",
          fileLocation: "src/config/aws.ts",
          lineStart: 42,
          lineEnd: 43,
          repository: "secureflow/core",
          pullRequest: 142,
          status: "OPEN",
          remediation: "Rotate AWS keys in IAM and update secret store.",
        },
        {
          id: "find-02",
          severity: "HIGH",
          type: "SQL_INJECTION",
          fileLocation: "src/db/users.ts",
          lineStart: 18,
          repository: "secureflow/core",
          status: "RESOLVED",
        },
      ];

      const html = generateShareableReportHtml({
        findings,
        reportId: "SEC-TEST-002",
        repositoryName: "secureflow/core",
      });

      expect(html).toContain("SEC-TEST-002");
      expect(html).toContain("Heist Risk Score");
      expect(html).toContain("Vault Integrity Status");
      expect(html).toContain("#5A29E4");
      expect(html).toContain("#0A5C3E");
      expect(html).toContain("AWS_SECRET_KEY");
      expect(html).toContain("src/config/aws.ts:42-43");
      expect(html).toContain("Rotate AWS keys in IAM and update secret store.");
      expect(html).toContain("The Professor's Strategic Directive");
      expect(html).toContain("SQL_INJECTION");
      expect(html).toContain("@media print");
    });
  });
});
