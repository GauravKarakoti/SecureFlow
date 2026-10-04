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
import { severityFromCvssEntries } from "./cvss";
import { compareVersions } from "./version-compare";

const OSV_QUERY_URL = "https://api.osv.dev/v1/query";
const OSV_VULN_URL = "https://api.osv.dev/v1/vulns";
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
    severity?: Array<{ type: string; score: string }>;
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

  // No curated label (the usual case outside GitHub-reviewed advisories): score
  // the CVSS vector OSV provides, advisory-level first, then per package.
  const fromCvss =
    severityFromCvssEntries(vuln.severity) ??
    severityFromCvssEntries((vuln.affected ?? []).flatMap((affected) => affected.severity ?? []));
  if (fromCvss) return fromCvss;

  return "MEDIUM";
}

/** One `[introduced, fixed)` (or `[introduced, last_affected]`) span of an OSV range. */
interface AffectedInterval {
  introduced: string;
  fixed: string | null;
  lastAffected: string | null;
}

/**
 * Turn a range's flat event list into discrete intervals.
 *
 * A single OSV range routinely carries several `introduced`/`fixed` pairs, one
 * per maintained release line (`semver`: fixed in 5.7.2, 6.3.1 and 7.5.2).
 * Reading only the first `fixed` event, as this used to, reports the oldest
 * branch's fix to everyone.
 */
function rangeIntervals(range: OsvAffectedRange): AffectedInterval[] {
  const intervals: AffectedInterval[] = [];
  let open: string | null = null;

  for (const event of range.events ?? []) {
    if (event.introduced !== undefined) {
      if (open !== null) intervals.push({ introduced: open, fixed: null, lastAffected: null });
      open = event.introduced;
    } else if (event.fixed) {
      intervals.push({ introduced: open ?? "0", fixed: event.fixed, lastAffected: null });
      open = null;
    } else if (event.last_affected) {
      intervals.push({ introduced: open ?? "0", fixed: null, lastAffected: event.last_affected });
      open = null;
    }
  }

  if (open !== null) intervals.push({ introduced: open, fixed: null, lastAffected: null });

  return intervals;
}

function containsVersion(interval: AffectedInterval, version: string): boolean {
  if (compareVersions(version, interval.introduced) < 0) return false;
  if (interval.fixed !== null) return compareVersions(version, interval.fixed) < 0;
  if (interval.lastAffected !== null) return compareVersions(version, interval.lastAffected) <= 0;
  return true;
}

function lowestVersion(versions: string[]): string | null {
  let lowest: string | null = null;
  for (const version of versions) {
    if (lowest === null || compareVersions(version, lowest) < 0) lowest = version;
  }
  return lowest;
}

type OsvAffected = NonNullable<OsvVulnerability["affected"]>[number];

function pickFixedVersion(entries: OsvAffected[], installedVersion: string | null): string | null {
  // `GIT` ranges express `fixed` as a commit hash, which is not a version anyone
  // can install.
  const intervals = entries.flatMap((entry) =>
    (entry.ranges ?? []).filter((range) => range.type !== "GIT").flatMap(rangeIntervals),
  );
  const fixes = intervals.flatMap((interval) => (interval.fixed ? [interval.fixed] : []));

  if (fixes.length === 0) return null;

  // Without an installed version there is nothing to select on; keep the
  // historical "first fixed event" answer.
  if (installedVersion === null) return fixes[0];

  // The fix for the release line the installed version is on...
  const containing = intervals
    .filter((interval) => interval.fixed !== null && containsVersion(interval, installedVersion))
    .map((interval) => interval.fixed as string);
  const own = lowestVersion(containing);
  if (own) return own;

  // ...otherwise the nearest fix that is actually an upgrade. A fix at or below
  // the installed version is never returned: "update to 5.2.4 or higher" is no
  // advice to someone already on 8.16.0.
  return lowestVersion(fixes.filter((fix) => compareVersions(fix, installedVersion) > 0));
}

/**
 * The version that resolves the advisory for `installedVersion`.
 *
 * Advisories often list a fix per release line, so the installed version decides
 * which one applies. When `installedVersion` is omitted (or `unknown`) the first
 * fixed version in document order is returned, as before.
 */
export function extractFixedVersion(
  vuln: OsvVulnerability,
  packageName: string,
  installedVersion?: string | null,
): string | null {
  const installed = installedVersion?.trim();
  const target = installed && installed !== "unknown" ? installed : null;
  const lowerName = packageName.toLowerCase();
  const affected = vuln.affected ?? [];

  const named = affected.filter((entry) => entry.package?.name?.toLowerCase() === lowerName);

  return pickFixedVersion(named, target) ?? pickFixedVersion(affected, target);
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
    patchedVersion: extractFixedVersion(vuln, dep.name, dep.version),
  }));
}

// ── Query by vulnerability ID ──────────────────────────────────────────

/**
 * Fetches an authoritative vulnerability record from OSV.dev by vulnerability ID (CVE, GHSA, OSV, etc.).
 * Returns `null` if the vulnerability is not found (404) or on invalid input/error.
 */
export async function fetchOsvVulnerabilityById(
  vulnerabilityId: string,
): Promise<OsvVulnerability | null> {
  if (!vulnerabilityId || typeof vulnerabilityId !== "string") return null;
  const cleanId = vulnerabilityId.trim();
  if (!cleanId) return null;

  try {
    const res = await fetch(`${OSV_VULN_URL}/${encodeURIComponent(cleanId)}`, {
      method: "GET",
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(OSV_TIMEOUT_MS),
    });

    if (res.status === 404) {
      return null;
    }

    if (!res.ok) {
      console.warn(
        `[OSV] Failed to fetch vulnerability ${cleanId}: ${res.status} ${res.statusText}`,
      );
      return null;
    }

    const data: OsvVulnerability = await res.json();
    return data && data.id ? data : null;
  } catch (err) {
    console.warn(
      `[OSV] Error fetching vulnerability ${cleanId}:`,
      err instanceof Error ? err.message : err,
    );
    return null;
  }
}
