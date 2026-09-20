/**
 * Client for the OSV.dev vulnerability database API.
 *
 * Uses the per-package query endpoint (`/v1/query`) which returns full advisory
 * data — summary, aliases, severity, affected ranges, and database-specific
 * fields.  The batch endpoint (`/v1/querybatch`) only returns `{id, modified}`
 * stubs and is not used.
 *
 * @see https://osv.dev/docs/#tag/api/post/v1/query
 */

import type { Dependency, SeverityLevel, VulnerabilityMatch } from "@/types/sbom";

const OSV_QUERY_URL = "https://api.osv.dev/v1/query";
const OSV_TIMEOUT_MS = 15_000;

const ECOSYSTEM_MAP: Record<string, string> = {
  npm: "npm",
  pypi: "PyPI",
  maven: "Maven",
  gem: "RubyGems",
};

// ── OSV response types ─────────────────────────────────────────────────

interface OsvRangeEvent {
  introduced?: string;
  fixed?: string;
  last_affected?: string;
}

interface OsvAffectedRange {
  type: string;
  events: OsvRangeEvent[];
}

export interface OsvVulnerability {
  id: string;
  summary?: string;
  details?: string;
  aliases?: string[];
  severity?: Array<{ type: string; score: string }>;
  affected?: Array<{
    package?: { name: string; ecosystem: string };
    ranges?: OsvAffectedRange[];
    database_specific?: Record<string, unknown>;
  }>;
  database_specific?: Record<string, unknown>;
}

interface OsvQueryResponse {
  vulns?: OsvVulnerability[];
}

// ── Ecosystem mapping ──────────────────────────────────────────────────

export function mapEcosystem(ecosystem: string): string | null {
  return ECOSYSTEM_MAP[ecosystem] ?? null;
}

// ── Response field extractors ──────────────────────────────────────────

export function extractCveId(vuln: OsvVulnerability): string {
  return vuln.aliases?.find((a) => a.startsWith("CVE-")) ?? vuln.id;
}

const SEVERITY_ALIASES: Record<string, SeverityLevel> = {
  CRITICAL: "CRITICAL",
  HIGH: "HIGH",
  MEDIUM: "MEDIUM",
  MODERATE: "MEDIUM",
  LOW: "LOW",
};

function asSeverity(value: unknown): SeverityLevel | null {
  if (typeof value !== "string") return null;
  return SEVERITY_ALIASES[value.toUpperCase()] ?? null;
}

export function extractSeverity(vuln: OsvVulnerability): SeverityLevel {
  const fromDb = asSeverity(vuln.database_specific?.severity);
  if (fromDb) return fromDb;

  for (const affected of vuln.affected ?? []) {
    const fromAffected = asSeverity(affected.database_specific?.severity);
    if (fromAffected) return fromAffected;
  }

  return "MEDIUM";
}

export function extractFixedVersion(vuln: OsvVulnerability, packageName: string): string | null {
  const lowerName = packageName.toLowerCase();

  for (const affected of vuln.affected ?? []) {
    if (affected.package?.name?.toLowerCase() !== lowerName) continue;
    for (const range of affected.ranges ?? []) {
      for (const event of range.events) {
        if (event.fixed) return event.fixed;
      }
    }
  }

  for (const affected of vuln.affected ?? []) {
    for (const range of affected.ranges ?? []) {
      for (const event of range.events) {
        if (event.fixed) return event.fixed;
      }
    }
  }

  return null;
}

// ── Per-dependency query ───────────────────────────────────────────────

export async function queryOsvForDependency(dep: Dependency): Promise<OsvVulnerability[]> {
  const ecosystem = mapEcosystem(dep.ecosystem);
  if (!ecosystem || !dep.version || dep.version === "unknown") return [];

  const res = await fetch(OSV_QUERY_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      package: { name: dep.name, ecosystem },
      version: dep.version,
    }),
    signal: AbortSignal.timeout(OSV_TIMEOUT_MS),
  });

  if (!res.ok) {
    throw new Error(`OSV API error: ${res.status} ${res.statusText}`);
  }

  const data: OsvQueryResponse = await res.json();
  return data.vulns ?? [];
}

// ── Map vulns → VulnerabilityMatch[] ───────────────────────────────────

export function mapOsvVulns(dep: Dependency, vulns: OsvVulnerability[]): VulnerabilityMatch[] {
  return vulns.map((vuln) => ({
    dependency: dep,
    cveId: extractCveId(vuln),
    severity: extractSeverity(vuln),
    description:
      vuln.summary ?? vuln.details?.slice(0, 200) ?? `Known vulnerability in ${dep.name}`,
    patchedVersion: extractFixedVersion(vuln, dep.name),
  }));
}
