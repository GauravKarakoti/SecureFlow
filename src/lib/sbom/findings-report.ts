import type { SbomScanResult, SeverityLevel, VulnerabilityMatch } from "@/types/sbom";
import { isSupportedManifest } from "./dependency-parser";

/** The fields of a findings-page row this module reads. */
export interface SbomFindingInput {
  type: string;
  severity: string;
  fileLocation: string;
  codeSnippet: string | null;
  explanation: string | null;
}

/**
 * The snippet the SBOM worker stores for a dependency finding:
 * `Dependency: <name>@<version>\nPatched: <version | Unknown>`.
 *
 * The name match is greedy so a scoped npm package (`@scope/pkg@1.0.0`) splits at its last `@`.
 */
const DEPENDENCY_SNIPPET = /^Dependency: (.+)@([^@\n]+)\nPatched: (.*)$/;

const CARD_SEVERITIES: readonly SeverityLevel[] = ["CRITICAL", "HIGH", "MEDIUM", "LOW"];

/**
 * Whether a finding was written by the SBOM worker.
 *
 * There is no dedicated finding type: the worker stores dependency findings as `VULNERABILITY`
 * against the manifest file, with the snippet above.
 */
export function isSbomFinding(finding: SbomFindingInput): boolean {
  return (
    finding.type === "VULNERABILITY" &&
    isSupportedManifest(finding.fileLocation) &&
    DEPENDENCY_SNIPPET.test(finding.codeSnippet ?? "")
  );
}

function toVulnerabilityMatch(finding: SbomFindingInput): VulnerabilityMatch {
  const [, name, version, patched] = DEPENDENCY_SNIPPET.exec(finding.codeSnippet ?? "") ?? [];
  const description = finding.explanation ?? "";
  // The card has no INFO level; the lowest level it can show is LOW.
  const severity = CARD_SEVERITIES.find((level) => level === finding.severity) ?? "LOW";

  return {
    dependency: {
      name,
      version,
      manifestFile: finding.fileLocation,
      ecosystem: finding.fileLocation.endsWith("package.json") ? "npm" : "pypi",
    },
    cveId: description.match(/CVE-\d{4}-\d+/)?.[0] ?? "CVE-Aggregated",
    severity,
    description,
    patchedVersion: patched && patched !== "Unknown" ? patched : null,
  };
}

/** The Dependency Security card for the SBOM findings on this page, or null when there are none. */
export function buildSbomReport(findings: readonly SbomFindingInput[]): SbomScanResult | null {
  const sbomFindings = findings.filter(isSbomFinding);
  if (sbomFindings.length === 0) return null;

  return {
    scanId: "aggregated-scan",
    timestamp: new Date(),
    totalDependencies: sbomFindings.length,
    vulnerabilities: sbomFindings.map(toVulnerabilityMatch),
    status: sbomFindings.some((f) => f.severity === "CRITICAL" || f.severity === "HIGH")
      ? "VULNERABLE"
      : "WARNING",
  };
}
