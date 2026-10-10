/**
 * Compliance Framework Policy Packs
 *
 * Pre-defined, industry-standard policy templates tailored for specific compliance regimes:
 * - SOC 2 Type II
 * - PCI-DSS v4.0
 * - OWASP Top 10 (2021)
 * - HIPAA Security Rule
 * - ISO/IEC 27001:2022
 */

export interface CompliancePackRuleConfig {
  blockOnCriticalSecrets?: boolean;
  blockOnCriticalVulnerabilities?: boolean;
  blockOnHighVulnerabilities?: boolean;
  requireReviewOnMedium?: boolean;
  blockedComplianceTags?: string[];
  maxAllowedFindings?: number;
}

export interface ComplianceFrameworkPack {
  id: string;
  name: string;
  framework: "SOC2" | "PCI-DSS" | "OWASP" | "HIPAA" | "ISO27001" | "NIST";
  description: string;
  severity: "CRITICAL" | "HIGH" | "MEDIUM";
  action: "BLOCKED" | "REVIEW REQUIRED";
  complianceTags: string[];
  rules: CompliancePackRuleConfig;
  isDefault: boolean;
}

export const SOC2_BASELINE_PACK: ComplianceFrameworkPack = {
  id: "pack-soc2-baseline",
  name: "SOC 2 Type II Security Baseline",
  framework: "SOC2",
  description: "Enforces zero-tolerance for critical secrets (CC6.1) and critical system vulnerabilities (CC7.1) on protected branches.",
  severity: "CRITICAL",
  action: "BLOCKED",
  complianceTags: ["SOC2:CC6.1", "SOC2:CC6.6", "SOC2:CC6.8", "SOC2:CC7.1"],
  rules: {
    blockOnCriticalSecrets: true,
    blockOnCriticalVulnerabilities: true,
    requireReviewOnMedium: true,
    blockedComplianceTags: ["SOC2:CC6.1", "SOC2:CC7.1"],
  },
  isDefault: true,
};

export const PCI_DSS_PAYMENT_PACK: ComplianceFrameworkPack = {
  id: "pack-pci-dss-v4",
  name: "PCI-DSS v4.0 Payment Security Pack",
  framework: "PCI-DSS",
  description: "Blocks PRs with exposed keys/secrets (Req 3.4), injection vulnerabilities (Req 6.5), or authentication flaws (Req 8.2).",
  severity: "CRITICAL",
  action: "BLOCKED",
  complianceTags: ["PCI-DSS:3.4", "PCI-DSS:6.4", "PCI-DSS:6.5", "PCI-DSS:8.2"],
  rules: {
    blockOnCriticalSecrets: true,
    blockOnCriticalVulnerabilities: true,
    blockOnHighVulnerabilities: true,
    blockedComplianceTags: ["PCI-DSS:3.4", "PCI-DSS:6.5"],
  },
  isDefault: false,
};

export const OWASP_TOP10_PACK: ComplianceFrameworkPack = {
  id: "pack-owasp-top10",
  name: "OWASP Top 10 2021 Enforcer",
  framework: "OWASP",
  description: "Blocks any PR introducing Critical or High OWASP Top 10 vulnerabilities (Injections, Broken Access, SSRF).",
  severity: "HIGH",
  action: "BLOCKED",
  complianceTags: [
    "OWASP:A01:2021",
    "OWASP:A02:2021",
    "OWASP:A03:2021",
    "OWASP:A05:2021",
    "OWASP:A07:2021",
    "OWASP:A10:2021",
  ],
  rules: {
    blockOnCriticalVulnerabilities: true,
    blockOnHighVulnerabilities: true,
    requireReviewOnMedium: true,
  },
  isDefault: true,
};

export const HIPAA_SECURITY_PACK: ComplianceFrameworkPack = {
  id: "pack-hipaa-security",
  name: "HIPAA Security Rule Guard",
  framework: "HIPAA",
  description: "Mandates review and blocking for electronic Protected Health Information (ePHI) leakage and access control flaws.",
  severity: "HIGH",
  action: "REVIEW REQUIRED",
  complianceTags: ["HIPAA:164.312(a)(1)", "HIPAA:164.312(c)(1)", "HIPAA:164.312(e)(1)"],
  rules: {
    blockOnCriticalSecrets: true,
    requireReviewOnMedium: true,
    blockedComplianceTags: ["HIPAA:164.312(a)(1)", "HIPAA:164.312(e)(1)"],
  },
  isDefault: false,
};

export const ISO27001_SECURE_CODING_PACK: ComplianceFrameworkPack = {
  id: "pack-iso-27001",
  name: "ISO/IEC 27001 Secure Coding Baseline",
  framework: "ISO27001",
  description: "Validates adherence to technical vulnerability management (A.8.8) and cryptography controls (A.8.24).",
  severity: "HIGH",
  action: "BLOCKED",
  complianceTags: ["ISO27001:A.8.8", "ISO27001:A.8.24", "ISO27001:A.8.28"],
  rules: {
    blockOnCriticalVulnerabilities: true,
    blockOnCriticalSecrets: true,
  },
  isDefault: false,
};

export const DEFAULT_COMPLIANCE_PACKS: ComplianceFrameworkPack[] = [
  SOC2_BASELINE_PACK,
  PCI_DSS_PAYMENT_PACK,
  OWASP_TOP10_PACK,
  HIPAA_SECURITY_PACK,
  ISO27001_SECURE_CODING_PACK,
];
