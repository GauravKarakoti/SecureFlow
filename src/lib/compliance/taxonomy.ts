/**
 * Compliance Framework Taxonomy & Finding Mapping Engine
 *
 * Maps security findings (SECRET, VULNERABILITY, MISCONFIG) and CWE IDs to
 * standard regulatory & compliance criteria:
 * - OWASP Top 10 (2021)
 * - SOC 2 Type II Trust Services Criteria (CC6.1, CC6.6, CC6.8, CC7.1, CC7.2)
 * - PCI-DSS v4.0 (Req 3.4, 6.4, 6.5, 8.2)
 * - HIPAA Security Rule (164.312)
 * - ISO/IEC 27001:2022 (A.8.8, A.8.24, A.8.28)
 * - NIST SP 800-53 Rev. 5 (SI-2, IA-2, SC-28)
 */

import { normalizeFindingType } from "@/lib/finding-taxonomy";

export type ComplianceFramework =
  | "OWASP"
  | "SOC2"
  | "PCI-DSS"
  | "HIPAA"
  | "ISO27001"
  | "NIST";

export interface ComplianceCriterion {
  id: string; // e.g. "OWASP:A03:2021-Injection" or "SOC2:CC6.1"
  framework: ComplianceFramework;
  name: string;
  description: string;
  category: "ACCESS_CONTROL" | "CRYPTOGRAPHY" | "INJECTION" | "CONFIGURATION" | "SUPPLY_CHAIN" | "LOGGING" | "INTEGRITY";
}

/**
 * Standard compliance framework criteria catalog.
 */
export const COMPLIANCE_CRITERIA: Readonly<Record<string, ComplianceCriterion>> = {
  // ── OWASP Top 10 2021 ───────────────────────────────────────────────────────
  "OWASP:A01:2021": {
    id: "OWASP:A01:2021",
    framework: "OWASP",
    name: "A01:2021 - Broken Access Control",
    description: "Failures that allow unauthorized information disclosure, modification, or destruction.",
    category: "ACCESS_CONTROL",
  },
  "OWASP:A02:2021": {
    id: "OWASP:A02:2021",
    framework: "OWASP",
    name: "A02:2021 - Cryptographic Failures",
    description: "Exposure of sensitive data or hardcoded secrets and broken encryption algorithms.",
    category: "CRYPTOGRAPHY",
  },
  "OWASP:A03:2021": {
    id: "OWASP:A03:2021",
    framework: "OWASP",
    name: "A03:2021 - Injection",
    description: "Untrusted user data processed as command/query (SQLi, Command Injection, XSS, etc.).",
    category: "INJECTION",
  },
  "OWASP:A04:2021": {
    id: "OWASP:A04:2021",
    framework: "OWASP",
    name: "A04:2021 - Insecure Design",
    description: "Missing or ineffective security controls in application architecture.",
    category: "INTEGRITY",
  },
  "OWASP:A05:2021": {
    id: "OWASP:A05:2021",
    framework: "OWASP",
    name: "A05:2021 - Security Misconfiguration",
    description: "Insecure defaults, permissive CORS, unhardened cloud settings or debug endpoints.",
    category: "CONFIGURATION",
  },
  "OWASP:A06:2021": {
    id: "OWASP:A06:2021",
    framework: "OWASP",
    name: "A06:2021 - Vulnerable and Outdated Components",
    description: "Known CVEs in dependencies, outdated packages, or vulnerable third-party libraries.",
    category: "SUPPLY_CHAIN",
  },
  "OWASP:A07:2021": {
    id: "OWASP:A07:2021",
    framework: "OWASP",
    name: "A07:2021 - Identification and Authentication Failures",
    description: "Weak passwords, missing session invalidation, or missing MFA.",
    category: "ACCESS_CONTROL",
  },
  "OWASP:A08:2021": {
    id: "OWASP:A08:2021",
    framework: "OWASP",
    name: "A08:2021 - Software and Data Integrity Failures",
    description: "Insecure deserialization, untrusted CI/CD pipelines, or unsigned updates.",
    category: "INTEGRITY",
  },
  "OWASP:A09:2021": {
    id: "OWASP:A09:2021",
    framework: "OWASP",
    name: "A09:2021 - Security Logging and Monitoring Failures",
    description: "Insufficient logging of security-critical actions and missing audit trails.",
    category: "LOGGING",
  },
  "OWASP:A10:2021": {
    id: "OWASP:A10:2021",
    framework: "OWASP",
    name: "A10:2021 - Server-Side Request Forgery (SSRF)",
    description: "Flaws where server fetches a remote resource without validating supplied URL.",
    category: "INJECTION",
  },

  // ── SOC 2 Type II ─────────────────────────────────────────────────────────
  "SOC2:CC6.1": {
    id: "SOC2:CC6.1",
    framework: "SOC2",
    name: "SOC 2 CC6.1 - Logical Access & Key Management",
    description: "Protection of authentication credentials, API keys, and access controls against leakage.",
    category: "ACCESS_CONTROL",
  },
  "SOC2:CC6.6": {
    id: "SOC2:CC6.6",
    framework: "SOC2",
    name: "SOC 2 CC6.6 - Boundary Protection & Vulnerability Shielding",
    description: "Detection and prevention of security vulnerabilities that compromise system boundaries.",
    category: "INJECTION",
  },
  "SOC2:CC6.8": {
    id: "SOC2:CC6.8",
    framework: "SOC2",
    name: "SOC 2 CC6.8 - Malicious Code Prevention",
    description: "Prevention of unauthorized code execution, backdoors, or malicious logic insertion.",
    category: "INTEGRITY",
  },
  "SOC2:CC7.1": {
    id: "SOC2:CC7.1",
    framework: "SOC2",
    name: "SOC 2 CC7.1 - Vulnerability Scanning & Flaw Detection",
    description: "Automated vulnerability scanning and prompt identification of system weaknesses.",
    category: "SUPPLY_CHAIN",
  },
  "SOC2:CC7.2": {
    id: "SOC2:CC7.2",
    framework: "SOC2",
    name: "SOC 2 CC7.2 - Security Incident Remediation",
    description: "Timely remediation and triage of reported security vulnerabilities and anomalies.",
    category: "LOGGING",
  },

  // ── PCI-DSS v4.0 ──────────────────────────────────────────────────────────
  "PCI-DSS:3.4": {
    id: "PCI-DSS:3.4",
    framework: "PCI-DSS",
    name: "PCI-DSS 3.4 - Protection of Primary Account Data & Secrets",
    description: "Cryptographic protection of private keys, authentication secrets, and sensitive cardholder data.",
    category: "CRYPTOGRAPHY",
  },
  "PCI-DSS:6.4": {
    id: "PCI-DSS:6.4",
    framework: "PCI-DSS",
    name: "PCI-DSS 6.4 - Public-Facing Web Application Protection",
    description: "Protection of public applications against automated attacks, injections, and data tampering.",
    category: "INJECTION",
  },
  "PCI-DSS:6.5": {
    id: "PCI-DSS:6.5",
    framework: "PCI-DSS",
    name: "PCI-DSS 6.5 - Software Flaw Prevention (OWASP Alignment)",
    description: "Mitigation of common software vulnerabilities including injections, XSS, and buffer overflows.",
    category: "INJECTION",
  },
  "PCI-DSS:8.2": {
    id: "PCI-DSS:8.2",
    framework: "PCI-DSS",
    name: "PCI-DSS 8.2 - Authentication & Access Verification",
    description: "Robust identification and management of administrative and system credentials.",
    category: "ACCESS_CONTROL",
  },

  // ── HIPAA Security Rule ────────────────────────────────────────────────────
  "HIPAA:164.312(a)(1)": {
    id: "HIPAA:164.312(a)(1)",
    framework: "HIPAA",
    name: "HIPAA 164.312(a)(1) - Technical Access Controls",
    description: "Implementation of access control procedures to allow access only to authorized personnel.",
    category: "ACCESS_CONTROL",
  },
  "HIPAA:164.312(c)(1)": {
    id: "HIPAA:164.312(c)(1)",
    framework: "HIPAA",
    name: "HIPAA 164.312(c)(1) - ePHI Integrity Protection",
    description: "Mechanisms to corroborate that electronic protected health information has not been altered.",
    category: "INTEGRITY",
  },
  "HIPAA:164.312(e)(1)": {
    id: "HIPAA:164.312(e)(1)",
    framework: "HIPAA",
    name: "HIPAA 164.312(e)(1) - Transmission Security & Encryption",
    description: "Guarding against unauthorized access to sensitive ePHI that is transmitted over an electronic network.",
    category: "CRYPTOGRAPHY",
  },

  // ── ISO/IEC 27001:2022 ────────────────────────────────────────────────────
  "ISO27001:A.8.8": {
    id: "ISO27001:A.8.8",
    framework: "ISO27001",
    name: "ISO 27001 A.8.8 - Management of Technical Vulnerabilities",
    description: "Information about technical vulnerabilities of information systems being obtained, evaluated, and resolved.",
    category: "SUPPLY_CHAIN",
  },
  "ISO27001:A.8.24": {
    id: "ISO27001:A.8.24",
    framework: "ISO27001",
    name: "ISO 27001 A.8.24 - Use of Cryptography & Secrets",
    description: "Rules for effective use of cryptography and secret management are defined and implemented.",
    category: "CRYPTOGRAPHY",
  },
  "ISO27001:A.8.28": {
    id: "ISO27001:A.8.28",
    framework: "ISO27001",
    name: "ISO 27001 A.8.28 - Secure Coding Principles",
    description: "Principles for secure coding applied to software development.",
    category: "INJECTION",
  },

  // ── NIST SP 800-53 Rev. 5 ──────────────────────────────────────────────────
  "NIST:SI-2": {
    id: "NIST:SI-2",
    framework: "NIST",
    name: "NIST SP 800-53 SI-2 - Flaw Remediation",
    description: "Identify, report, and correct system flaws and software vulnerabilities within specified timeframes.",
    category: "SUPPLY_CHAIN",
  },
  "NIST:IA-2": {
    id: "NIST:IA-2",
    framework: "NIST",
    name: "NIST SP 800-53 IA-2 - Identification and Authentication",
    description: "Uniquely identify and authenticate organizational users and internal processes.",
    category: "ACCESS_CONTROL",
  },
  "NIST:SC-28": {
    id: "NIST:SC-28",
    framework: "NIST",
    name: "NIST SP 800-53 SC-28 - Protection of Information at Rest",
    description: "Protect the confidentiality and integrity of information at rest and cryptographic secrets.",
    category: "CRYPTOGRAPHY",
  },
};

/**
 * Common CWE ID mappings to compliance tags.
 */
const CWE_COMPLIANCE_MAP: Record<string, string[]> = {
  // Hardcoded Secrets & Credentials
  "CWE-798": ["OWASP:A02:2021", "SOC2:CC6.1", "PCI-DSS:3.4", "ISO27001:A.8.24", "NIST:SC-28"],
  "CWE-259": ["OWASP:A02:2021", "SOC2:CC6.1", "PCI-DSS:3.4", "ISO27001:A.8.24", "NIST:SC-28"],
  "CWE-312": ["OWASP:A02:2021", "SOC2:CC6.1", "PCI-DSS:3.4", "HIPAA:164.312(e)(1)", "NIST:SC-28"],
  "CWE-327": ["OWASP:A02:2021", "PCI-DSS:3.4", "ISO27001:A.8.24"],
  "CWE-330": ["OWASP:A02:2021", "PCI-DSS:3.4", "ISO27001:A.8.24"],

  // Injections
  "CWE-89": ["OWASP:A03:2021", "PCI-DSS:6.5", "SOC2:CC6.6", "ISO27001:A.8.28"], // SQLi
  "CWE-78": ["OWASP:A03:2021", "PCI-DSS:6.5", "SOC2:CC6.6", "ISO27001:A.8.28"], // OS Command Injection
  "CWE-79": ["OWASP:A03:2021", "PCI-DSS:6.5", "SOC2:CC6.6"], // XSS
  "CWE-94": ["OWASP:A03:2021", "PCI-DSS:6.5", "SOC2:CC6.8"], // Code Injection
  "CWE-918": ["OWASP:A10:2021", "SOC2:CC6.6", "PCI-DSS:6.5"], // SSRF
  "CWE-352": ["OWASP:A01:2021", "PCI-DSS:6.5", "SOC2:CC6.6"], // CSRF
  "CWE-22": ["OWASP:A01:2021", "PCI-DSS:6.5", "SOC2:CC6.6"], // Path Traversal

  // Broken Access Control & Auth
  "CWE-287": ["OWASP:A07:2021", "SOC2:CC6.1", "PCI-DSS:8.2", "HIPAA:164.312(a)(1)", "NIST:IA-2"],
  "CWE-306": ["OWASP:A01:2021", "SOC2:CC6.1", "HIPAA:164.312(a)(1)", "NIST:IA-2"],
  "CWE-862": ["OWASP:A01:2021", "SOC2:CC6.1", "HIPAA:164.312(a)(1)"],
  "CWE-639": ["OWASP:A01:2021", "SOC2:CC6.1", "HIPAA:164.312(a)(1)"], // IDOR

  // Misconfigurations
  "CWE-16": ["OWASP:A05:2021", "SOC2:CC6.6", "PCI-DSS:6.4"],
  "CWE-1004": ["OWASP:A05:2021", "SOC2:CC6.6", "PCI-DSS:6.4"], // Missing HttpOnly
  "CWE-732": ["OWASP:A05:2021", "SOC2:CC6.1", "PCI-DSS:6.4"], // Permissive permissions

  // Insecure Deserialization & Supply Chain
  "CWE-502": ["OWASP:A08:2021", "SOC2:CC6.8", "NIST:SI-2"],
  "CWE-1104": ["OWASP:A06:2021", "SOC2:CC7.1", "ISO27001:A.8.8", "NIST:SI-2"], // Outdated third party
  "CWE-1395": ["OWASP:A06:2021", "SOC2:CC7.1", "NIST:SI-2"], // Vulnerable component
};

/**
 * Extract CWE identifier from string (e.g. "CWE-89: SQL Injection" -> "CWE-89").
 */
export function extractCweId(raw: string): string | null {
  const match = raw.match(/CWE[-_](\d+)/i);
  return match ? `CWE-${match[1]}` : null;
}

/**
 * Maps a finding to an array of standardized compliance tags based on:
 * 1. Explicit CWE ID if present or mentioned in explanation
 * 2. Finding Type (SECRET, VULNERABILITY, MISCONFIG)
 * 3. Specific vulnerability indicators in explanation/snippet
 */
export function mapFindingToComplianceTags(finding: {
  type?: string;
  severity?: string;
  explanation?: string;
  codeSnippet?: string;
  fileLocation?: string;
  cwe?: string | string[];
}): string[] {
  const tags = new Set<string>();

  // 1. Process explicit CWE
  if (finding.cwe) {
    const cwes = Array.isArray(finding.cwe) ? finding.cwe : [finding.cwe];
    for (const rawCwe of cwes) {
      const cweId = extractCweId(rawCwe);
      if (cweId && CWE_COMPLIANCE_MAP[cweId]) {
        for (const tag of CWE_COMPLIANCE_MAP[cweId]) {
          tags.add(tag);
        }
      }
    }
  }

  // 2. Scan explanation & code snippet for embedded CWE references
  const fullText = `${finding.explanation || ""} ${finding.codeSnippet || ""} ${finding.type || ""}`.toLowerCase();
  const cweMatch = fullText.match(/cwe[-_](\d+)/gi);
  if (cweMatch) {
    for (const c of cweMatch) {
      const cweId = extractCweId(c);
      if (cweId && CWE_COMPLIANCE_MAP[cweId]) {
        for (const tag of CWE_COMPLIANCE_MAP[cweId]) {
          tags.add(tag);
        }
      }
    }
  }

  // 3. Category & Type based heuristic tagging
  const category = normalizeFindingType(finding.type);

  if (category === "SECRET") {
    tags.add("SOC2:CC6.1");
    tags.add("PCI-DSS:3.4");
    tags.add("OWASP:A02:2021");
    tags.add("ISO27001:A.8.24");
    tags.add("NIST:SC-28");
    tags.add("HIPAA:164.312(a)(1)");
  } else if (category === "MISCONFIG") {
    tags.add("OWASP:A05:2021");
    tags.add("SOC2:CC6.6");
    tags.add("PCI-DSS:6.4");
  } else if (category === "VULNERABILITY") {
    // Specific vulnerability heuristics from text
    if (fullText.includes("sql") || fullText.includes("injection") || fullText.includes("xss") || fullText.includes("command")) {
      tags.add("OWASP:A03:2021");
      tags.add("PCI-DSS:6.5");
      tags.add("SOC2:CC6.6");
      tags.add("ISO27001:A.8.28");
    } else if (fullText.includes("auth") || fullText.includes("access") || fullText.includes("permission")) {
      tags.add("OWASP:A01:2021");
      tags.add("SOC2:CC6.1");
      tags.add("HIPAA:164.312(a)(1)");
      tags.add("NIST:IA-2");
    } else if (fullText.includes("ssrf")) {
      tags.add("OWASP:A10:2021");
      tags.add("SOC2:CC6.6");
    } else if (fullText.includes("deserializ") || fullText.includes("integrity")) {
      tags.add("OWASP:A08:2021");
      tags.add("SOC2:CC6.8");
    } else if (fullText.includes("dependency") || fullText.includes("cve-") || fullText.includes("package")) {
      tags.add("OWASP:A06:2021");
      tags.add("SOC2:CC7.1");
      tags.add("ISO27001:A.8.8");
      tags.add("NIST:SI-2");
    } else {
      // Default baseline vulnerability tags
      tags.add("OWASP:A03:2021");
      tags.add("SOC2:CC6.6");
      tags.add("ISO27001:A.8.8");
    }
  }

  return Array.from(tags);
}

/**
 * Retrieve framework key from a tag (e.g. "SOC2:CC6.1" -> "SOC2").
 */
export function getFrameworkFromTag(tag: string): ComplianceFramework | "UNKNOWN" {
  if (tag.startsWith("OWASP:")) return "OWASP";
  if (tag.startsWith("SOC2:")) return "SOC2";
  if (tag.startsWith("PCI-DSS:")) return "PCI-DSS";
  if (tag.startsWith("HIPAA:")) return "HIPAA";
  if (tag.startsWith("ISO27001:")) return "ISO27001";
  if (tag.startsWith("NIST:")) return "NIST";
  return "UNKNOWN";
}
