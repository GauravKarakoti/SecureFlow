import {
  lookupCisaKevEntry,
  lookupOsvAdvisory,
  searchCisaKevCatalog,
  type CisaKevVulnerability,
} from "./threat-intel-feed.js";

export interface ThreatIntelligenceEntry {
  id: string;
  category: string;
  description: string;
  severity: string;
  cve?: string;
  remediationGuidance: string;
}

export interface ThreatIntelligenceSearchResult extends ThreatIntelligenceEntry {
  source: "CISA KEV" | "BUNDLED";
  knownExploited: boolean | null;
  dateAdded?: string;
  dueDate?: string;
  vendorProject?: string;
  product?: string;
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

function mapKevEntry(item: CisaKevVulnerability): ThreatIntelligenceSearchResult {
  return {
    id: item.cveID,
    cve: item.cveID,
    category: item.vulnerabilityName,
    description: item.shortDescription,
    severity: "not-provided",
    remediationGuidance: item.requiredAction,
    source: "CISA KEV",
    knownExploited: true,
    dateAdded: item.dateAdded,
    dueDate: item.dueDate,
    vendorProject: item.vendorProject,
    product: item.product,
  };
}

function mapBundledEntry(
  item: ThreatIntelligenceEntry,
): ThreatIntelligenceSearchResult {
  return {
    ...item,
    source: "BUNDLED",
    knownExploited: null,
  };
}

/**
 * Search CISA's synchronized KEV catalog and the bundled offline knowledge base.
 * The absence of a CVE from KEV is not evidence that it is harmless.
 */
export async function searchThreatIntelligence(
  query: string,
  limit = 20,
): Promise<ThreatIntelligenceSearchResult[]> {
  const normalized = query.trim().toLowerCase();

  if (!normalized || normalized.length > 200) return [];

  let liveMatches: CisaKevVulnerability[] = [];

  try {
    liveMatches = await searchCisaKevCatalog(normalized, limit);
  } catch {
    // The bundled knowledge base remains available during feed/cache outages.
  }

  const bundledMatches = KNOWLEDGE_BASE.filter(
    (item) =>
      item.id.toLowerCase().includes(normalized) ||
      item.description.toLowerCase().includes(normalized) ||
      item.category.toLowerCase().includes(normalized) ||
      (item.cve?.toLowerCase().includes(normalized) ?? false),
  );

  const results = new Map<string, ThreatIntelligenceSearchResult>();

  for (const item of bundledMatches) {
    results.set(item.id, mapBundledEntry(item));
  }

  for (const item of liveMatches) {
    const existing = results.get(item.cveID);
    const liveEntry = mapKevEntry(item);

    results.set(
      item.cveID,
      existing
        ? {
            ...liveEntry,
            category: existing.category,
            severity: existing.severity,
          }
        : liveEntry,
    );
  }

  return [...results.values()].slice(0, Math.max(1, Math.min(limit, 50)));
}

/**
 * Look up an individual CVE through OSV and CISA KEV.
 * Falls back to the bundled record when live services are unavailable or
 * do not contain the identifier.
 */
export async function lookupThreatIntelligenceById(
  identifier: string,
): Promise<Record<string, unknown> | null> {
  const normalized = identifier.trim().toUpperCase();

  if (!normalized || normalized.length > 100) return null;

  const bundled = KNOWLEDGE_BASE.find(
    (item) =>
      item.id.toUpperCase() === normalized ||
      item.cve?.toUpperCase() === normalized,
  );

  if (!/^CVE-\d{4}-\d{4,19}$/.test(normalized)) {
    return bundled
      ? { ...bundled, source: "BUNDLED", knownExploited: false }
      : null;
  }

  const [osvResult, kevResult] = await Promise.allSettled([
    lookupOsvAdvisory(normalized),
    lookupCisaKevEntry(normalized),
  ]);

  const osv = osvResult.status === "fulfilled" ? osvResult.value : null;
  const kev = kevResult.status === "fulfilled" ? kevResult.value : null;
  const liveLookupUnavailable =
    osvResult.status === "rejected" || kevResult.status === "rejected";

  if (osv || kev) {
    return {
      id: osv?.id ?? normalized,
      cve: normalized,
      aliases: osv?.aliases ?? [],
      summary: osv?.summary ?? kev?.vulnerabilityName ?? bundled?.category,
      category: bundled?.category ?? kev?.vulnerabilityName ?? "Vulnerability",
      details: osv?.details ?? kev?.shortDescription,
      published: osv?.published,
      modified: osv?.modified,
      severity: bundled?.severity ?? "unknown",
      affected: osv?.affected ?? [],
      source: osv && kev ? "OSV + CISA KEV" : osv ? "OSV" : "CISA KEV",
      knownExploited: kev ? true : kevResult.status === "fulfilled" ? false : null,
      cisaKev: kev,
      remediationGuidance:
        kev?.requiredAction ?? bundled?.remediationGuidance ??
        "Review the advisory's affected versions and apply the vendor-provided security update.",
      liveLookupUnavailable,
    };
  }

  if (bundled) {
    return {
      ...bundled,
      source: "BUNDLED",
      knownExploited: liveLookupUnavailable ? null : false,
      liveLookupUnavailable,
    };
  }

  return null;
}

/**
 * Backwards-compatible formatted lookup used by existing CLI consumers.
 */
export async function queryLiveThreatIntelligence(
  query: string,
): Promise<string> {
  const q = query.trim();

  if (!q) return "";

  const matches = await searchThreatIntelligence(q, 1);
  const match = matches[0];

  if (!match) return "";

  return `[Threat Intelligence Advisory - ${match.id} (${match.severity.toUpperCase()})]
Category: ${match.category}
Source: ${match.source}
Known exploited: ${match.knownExploited}
Guidance: ${match.remediationGuidance}`;
}
