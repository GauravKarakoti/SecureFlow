import type { Dependency } from "@/types/sbom";
import { diffSbomSnapshots, type SbomDiffResult } from "@/lib/sbom/sbom-diff";

/**
 * Scan Comparison Logic (#1923)
 *
 * Compares two scans of the same pull request by their finding fingerprints to classify:
 * - NEW: Findings present in the target scan that were not in the base scan.
 * - FIXED: Findings present in the base scan that are no longer in the target scan.
 * - UNCHANGED: Findings present in both scans.
 *
 * Scans that are marked failed or partial (e.g. files skipped due to size or timeout)
 * are rejected as not comparable with a descriptive message.
 */

export interface ScanFindingItem {
  id: string;
  fingerprint: string;
  type: string;
  severity: string;
  fileLocation: string;
  lineStart?: number | null;
  lineEnd?: number | null;
  codeSnippet?: string | null;
  explanation?: string | null;
  remediation?: string | null;
  createdAt?: Date | string;
}

export interface ComparableScanInput {
  id: string;
  headSha?: string | null;
  createdAt: Date | string;
  riskScore?: number;
  policyDecision?: string;
  findings: ScanFindingItem[];
  isPartial?: boolean;
  isFailed?: boolean;
  status?: string;
  totalFiles?: number;
  scannedFiles?: number;
  error?: string | null;
  dependencies?: Dependency[];
}

export type FindingDiffStatus = "NEW" | "FIXED" | "UNCHANGED";

export interface SeverityCounts {
  CRITICAL: number;
  HIGH: number;
  MEDIUM: number;
  LOW: number;
  [key: string]: number;
}

export interface DiffGroup {
  status: FindingDiffStatus;
  count: number;
  severityCounts: SeverityCounts;
  findings: ScanFindingItem[];
}

export interface ScanComparisonMetadata {
  id: string;
  headSha?: string | null;
  createdAt: Date | string;
  riskScore?: number;
  policyDecision?: string;
  status?: string;
  totalFiles?: number;
  scannedFiles?: number;
  isPartial?: boolean;
  isFailed?: boolean;
}

export interface ScanComparisonResult {
  isComparable: boolean;
  incomparableReason?: string;
  baseScan: ScanComparisonMetadata;
  targetScan: ScanComparisonMetadata;
  summary: {
    newCount: number;
    fixedCount: number;
    unchangedCount: number;
    newSeverityCounts: SeverityCounts;
    fixedSeverityCounts: SeverityCounts;
    unchangedSeverityCounts: SeverityCounts;
  };
  groups: {
    new: DiffGroup;
    fixed: DiffGroup;
    unchanged: DiffGroup;
  };
  sbomDiff?: SbomDiffResult;
}

/**
 * Checks whether a scan failed to execute or complete.
 */
export function isScanFailed(scan: ComparableScanInput): boolean {
  if (scan.isFailed) return true;
  if (typeof scan.status === "string" && scan.status.toUpperCase() === "FAILED") return true;
  if (typeof scan.error === "string" && scan.error.trim().length > 0) return true;
  return false;
}

/**
 * Checks whether a scan is partial (e.g., some files skipped due to deadline or size).
 */
export function isScanPartial(scan: ComparableScanInput): boolean {
  if (scan.isPartial) return true;
  if (typeof scan.status === "string" && scan.status.toUpperCase() === "PARTIAL") return true;
  if (
    typeof scan.totalFiles === "number" &&
    typeof scan.scannedFiles === "number" &&
    scan.totalFiles > 0 &&
    scan.scannedFiles < scan.totalFiles
  ) {
    return true;
  }
  return false;
}

/**
 * Initializes empty severity counts.
 */
export function createEmptySeverityCounts(): SeverityCounts {
  return {
    CRITICAL: 0,
    HIGH: 0,
    MEDIUM: 0,
    LOW: 0,
  };
}

/**
 * Computes severity counts for a collection of findings.
 */
export function computeSeverityCounts(findings: readonly ScanFindingItem[]): SeverityCounts {
  const counts = createEmptySeverityCounts();
  for (const f of findings) {
    const raw = (f.severity || "LOW").toUpperCase();
    counts[raw] = (counts[raw] || 0) + 1;
  }
  return counts;
}

/**
 * Creates scan metadata snapshot for comparison output.
 */
function extractScanMetadata(scan: ComparableScanInput): ScanComparisonMetadata {
  return {
    id: scan.id,
    headSha: scan.headSha,
    createdAt: scan.createdAt,
    riskScore: scan.riskScore,
    policyDecision: scan.policyDecision,
    status: scan.status,
    totalFiles: scan.totalFiles,
    scannedFiles: scan.scannedFiles,
    isPartial: isScanPartial(scan),
    isFailed: isScanFailed(scan),
  };
}

/**
 * Compares two scans of the same PR and groups results into New, Fixed, and Unchanged.
 *
 * @param baseScan The baseline / earlier scan.
 * @param targetScan The target / later scan.
 */
export function compareScans(
  baseScan: ComparableScanInput,
  targetScan: ComparableScanInput,
): ScanComparisonResult {
  const baseMeta = extractScanMetadata(baseScan);
  const targetMeta = extractScanMetadata(targetScan);

  const emptySummary = {
    newCount: 0,
    fixedCount: 0,
    unchangedCount: 0,
    newSeverityCounts: createEmptySeverityCounts(),
    fixedSeverityCounts: createEmptySeverityCounts(),
    unchangedSeverityCounts: createEmptySeverityCounts(),
  };

  const emptyGroups = {
    new: {
      status: "NEW" as const,
      count: 0,
      severityCounts: createEmptySeverityCounts(),
      findings: [],
    },
    fixed: {
      status: "FIXED" as const,
      count: 0,
      severityCounts: createEmptySeverityCounts(),
      findings: [],
    },
    unchanged: {
      status: "UNCHANGED" as const,
      count: 0,
      severityCounts: createEmptySeverityCounts(),
      findings: [],
    },
  };

  // Check failed scans
  if (isScanFailed(baseScan)) {
    return {
      isComparable: false,
      incomparableReason: "Base scan failed and cannot be compared.",
      baseScan: baseMeta,
      targetScan: targetMeta,
      summary: emptySummary,
      groups: emptyGroups,
    };
  }

  if (isScanFailed(targetScan)) {
    return {
      isComparable: false,
      incomparableReason: "Target scan failed and cannot be compared.",
      baseScan: baseMeta,
      targetScan: targetMeta,
      summary: emptySummary,
      groups: emptyGroups,
    };
  }

  // Check partial scans
  if (isScanPartial(baseScan)) {
    return {
      isComparable: false,
      incomparableReason:
        "Base scan is a partial scan (some files were skipped) and cannot be compared.",
      baseScan: baseMeta,
      targetScan: targetMeta,
      summary: emptySummary,
      groups: emptyGroups,
    };
  }

  if (isScanPartial(targetScan)) {
    return {
      isComparable: false,
      incomparableReason:
        "Target scan is a partial scan (some files were skipped) and cannot be compared.",
      baseScan: baseMeta,
      targetScan: targetMeta,
      summary: emptySummary,
      groups: emptyGroups,
    };
  }

  // Index base fingerprints
  const baseFpSet = new Set(
    (baseScan.findings || [])
      .map((f) => f.fingerprint?.trim())
      .filter((fp): fp is string => Boolean(fp)),
  );

  // Index target fingerprints
  const targetFpSet = new Set(
    (targetScan.findings || [])
      .map((f) => f.fingerprint?.trim())
      .filter((fp): fp is string => Boolean(fp)),
  );

  const newFindings: ScanFindingItem[] = [];
  const unchangedFindings: ScanFindingItem[] = [];
  const fixedFindings: ScanFindingItem[] = [];

  // Findings in target: either UNCHANGED or NEW
  for (const f of targetScan.findings || []) {
    const fp = f.fingerprint?.trim();
    if (fp && baseFpSet.has(fp)) {
      unchangedFindings.push(f);
    } else {
      newFindings.push(f);
    }
  }

  // Findings in base: if not in target, then FIXED
  for (const f of baseScan.findings || []) {
    const fp = f.fingerprint?.trim();
    if (!fp || !targetFpSet.has(fp)) {
      fixedFindings.push(f);
    }
  }

  const newSeverityCounts = computeSeverityCounts(newFindings);
  const fixedSeverityCounts = computeSeverityCounts(fixedFindings);
  const unchangedSeverityCounts = computeSeverityCounts(unchangedFindings);

  const hasDependencies =
    Array.isArray(baseScan.dependencies) || Array.isArray(targetScan.dependencies);
  const sbomDiff = hasDependencies
    ? diffSbomSnapshots(baseScan.dependencies ?? [], targetScan.dependencies ?? [])
    : undefined;

  return {
    isComparable: true,
    baseScan: baseMeta,
    targetScan: targetMeta,
    summary: {
      newCount: newFindings.length,
      fixedCount: fixedFindings.length,
      unchangedCount: unchangedFindings.length,
      newSeverityCounts,
      fixedSeverityCounts,
      unchangedSeverityCounts,
    },
    groups: {
      new: {
        status: "NEW",
        count: newFindings.length,
        severityCounts: newSeverityCounts,
        findings: newFindings,
      },
      fixed: {
        status: "FIXED",
        count: fixedFindings.length,
        severityCounts: fixedSeverityCounts,
        findings: fixedFindings,
      },
      unchanged: {
        status: "UNCHANGED",
        count: unchangedFindings.length,
        severityCounts: unchangedSeverityCounts,
        findings: unchangedFindings,
      },
    },
    ...(sbomDiff ? { sbomDiff } : {}),
  };
}
