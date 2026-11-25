/**
 * Type definitions for Software Bill of Materials (SBOM) scanning.
 */

export type SeverityLevel = "LOW" | "MEDIUM" | "HIGH" | "CRITICAL";

export interface Dependency {
  name: string;
  version: string;
  manifestFile: string;
  ecosystem: "npm" | "pypi" | "maven" | "gem" | "cargo" | "go";
  isTransitive?: boolean;
  parentPackage?: string;
  license?: string;
}

export interface VulnerabilityMatch {
  dependency: Dependency;
  cveId: string;
  severity: SeverityLevel;
  description: string;
  patchedVersion: string | null;
}

export interface SbomScanResult {
  scanId: string;
  timestamp: Date;
  totalDependencies: number;
  vulnerabilities: VulnerabilityMatch[];
  status: "CLEAN" | "WARNING" | "VULNERABLE" | "ERROR";
}
