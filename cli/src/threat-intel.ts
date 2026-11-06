export async function queryLiveThreatIntelligence(query: string): Promise<string> {
  const q = query.toLowerCase();
  const match = KNOWLEDGE_BASE.find(
    (item) =>
      item.description.toLowerCase().includes(q) ||
      item.category.toLowerCase().includes(q) ||
      (item.cve && item.cve.toLowerCase().includes(q)),
  );

  if (match) {
    return `[Threat Intelligence Advisory - ${match.id} (${match.severity.toUpperCase()})]
Category: ${match.category}
Guidance: ${match.remediationGuidance}`;
  }

  return "";
}

export const KNOWLEDGE_BASE: ThreatIntelligenceEntry[] = [
  {
    id: "CVE-2023-3409",
    category: "SQL Injection",
    description:
      "Improper neutralization of special elements used in an SQL command leads to arbitrary data exfiltration.",
    severity: "critical",
    cve: "CVE-2023-3409",
    remediationGuidance:
      "Replace string concatenation with parameterized prepared statements or ORM abstractions with strict type casting.",
  },
  {
    id: "CVE-2023-28154",
    category: "Server-Side Request Forgery",
    description:
      "SSRF vulnerability allowing attackers to make arbitrary network requests from the server to internal metadata endpoints or private subnets.",
    severity: "high",
    cve: "CVE-2023-28154",
    remediationGuidance:
      "Enforce strict allowlists of public protocols (HTTPS only) and disallow loopback (127.0.0.1) or link-local/private IP ranges.",
  },
  {
    id: "SEC-LEAK-001",
    category: "Secret Logging",
    description: "Sensitive secrets, tokens, or private keys exposed in runtime application logs.",
    severity: "high",
    remediationGuidance:
      "Mask or redact secret variables prior to logging, or omit credentials entirely from logging sinks.",
  },
  {
    id: "CWE-79",
    category: "Cross-Site Scripting",
    description: "Unsanitized user-controlled input rendered directly into DOM or HTML output.",
    severity: "high",
    remediationGuidance:
      "Use context-aware HTML entity encoding or modern reactive framework templating that auto-escapes dynamic values.",
  },
  {
    id: "CWE-94",
    category: "Prompt Injection",
    description:
      "Adversarial override attempting to hijack LLM system instructions or exfiltrate private intent tokens.",
    severity: "critical",
    remediationGuidance:
      "Wrap tool execution behind cryptographic intent verification (ArmorIQ) and apply fail-closed boundary enforcement.",
  },
];

export interface ThreatIntelligenceEntry {
  id: string;
  category: string;
  description: string;
  severity: string;
  cve?: string;
  remediationGuidance: string;
}
