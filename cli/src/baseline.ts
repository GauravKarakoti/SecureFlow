/**
 * Findings Baseline Engine for SecureFlow CLI (#2060)
 *
 * Records known existing violations in legacy codebases (.secureflow-baseline.json)
 * and filters them out of pre-commit and CI scans so commits only fail on
 * newly introduced security violations.
 */

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import type { FileScanResult, Violation, Severity } from "./scanner.js";
import { normalizeScanPath } from "./ignore.js";

export const DEFAULT_BASELINE_FILENAME = ".secureflow-baseline.json";

export interface BaselineViolation {
  fingerprint: string;
  path: string;
  line: number;
  reason: string;
  ruleId?: string | undefined;
  snippet: string;
  snippetHash: string;
  severity?: Severity | undefined;
}

export interface BaselineFile {
  version: 1 | string;
  generatedAt?: string | undefined;
  createdAt?: string | undefined;
  generator?: string | undefined;
  gitCommit?: string | undefined;
  toolVersion?: string | undefined;
  violations: BaselineViolation[];
}

export interface FilterBaselineResult {
  filteredResults: FileScanResult[];
  results: FileScanResult[];
  baselineSuppressedCount: number;
  suppressedCount: number;
  newViolationCount: number;
  newCount: number;
}

export interface UpdateBaselineResult {
  updatedBaseline: BaselineFile;
  addedCount: number;
  removedCount: number;
}

/**
 * Computes SHA-256 fingerprint of snippet string.
 */
export function computeSnippetHash(snippet: string): string {
  return crypto.createHash("sha256").update(snippet.trim()).digest("hex");
}

/**
 * Computes deterministic context fingerprint for a baseline entry.
 */
export function computeBaselineFingerprint(
  filePath: string,
  reason: string,
  snippet: string,
  ruleId?: string,
): string {
  const normPath = normalizeScanPath(filePath);
  const normSnippet = snippet.trim();
  const rulePart = ruleId ? ruleId.trim() : reason.trim();
  return crypto
    .createHash("sha256")
    .update(`${normPath}::${rulePart}::${normSnippet}`)
    .digest("hex");
}

/**
 * Creates a BaselineFile document from current file scan results.
 */
export function createBaselineFromResults(
  results: FileScanResult[],
  options?: { gitCommit?: string | undefined; toolVersion?: string | undefined },
): BaselineFile {
  const violations: BaselineViolation[] = [];
  const seenFingerprints = new Set<string>();

  for (const fileResult of results) {
    const normPath = normalizeScanPath(fileResult.path);
    for (const v of fileResult.violations) {
      const snippetHash = computeSnippetHash(v.text);
      const fingerprint = computeBaselineFingerprint(normPath, v.reason, v.text, v.ruleId);

      if (!seenFingerprints.has(fingerprint)) {
        seenFingerprints.add(fingerprint);
        violations.push({
          fingerprint,
          path: normPath,
          line: v.line,
          reason: v.reason,
          ruleId: v.ruleId,
          snippet: v.text.trim(),
          snippetHash,
          ...(v.severity ? { severity: v.severity } : {}),
        });
      }
    }
  }

  // Stable sort by path then line
  violations.sort((a, b) => {
    if (a.path !== b.path) return a.path.localeCompare(b.path);
    return a.line - b.line;
  });

  return {
    version: 1,
    generatedAt: new Date().toISOString(),
    gitCommit: options?.gitCommit,
    toolVersion: options?.toolVersion || "3.10.0",
    violations,
  };
}

/**
 * Loads and validates a baseline file from disk.
 * Returns null if file does not exist or is invalid JSON/schema.
 */
export function loadBaseline(
  baselinePath: string = DEFAULT_BASELINE_FILENAME,
  repoRoot?: string,
): BaselineFile | null {
  const targetPath = repoRoot && !path.isAbsolute(baselinePath)
    ? path.resolve(repoRoot, baselinePath)
    : path.resolve(baselinePath);

  if (!fs.existsSync(targetPath)) {
    return null;
  }

  try {
    const raw = fs.readFileSync(targetPath, "utf-8");
    const data = JSON.parse(raw);

    if (
      !data ||
      typeof data !== "object" ||
      (data.version !== 1 && data.version !== "1.0.0") ||
      !Array.isArray(data.violations)
    ) {
      return null;
    }

    return data as BaselineFile;
  } catch {
    return null;
  }
}

/**
 * Writes a baseline document to disk.
 */
export function saveBaseline(
  baseline: BaselineFile,
  baselinePath: string = DEFAULT_BASELINE_FILENAME,
  repoRoot?: string,
): string {
  const targetPath = repoRoot && !path.isAbsolute(baselinePath)
    ? path.resolve(repoRoot, baselinePath)
    : path.resolve(baselinePath);

  const dir = path.dirname(targetPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  fs.writeFileSync(targetPath, JSON.stringify(baseline, null, 2) + "\n", "utf-8");
  return targetPath;
}

/**
 * Matches a violation against baseline entries with line-shift tolerance.
 */
export function matchViolationAgainstBaseline(
  violation: Violation,
  filePath: string,
  baselineViolations: BaselineViolation[],
): BaselineViolation | null {
  const normPath = normalizeScanPath(filePath);
  const snippet = violation.text.trim();
  const snippetHash = computeSnippetHash(snippet);
  const fingerprint = computeBaselineFingerprint(normPath, violation.reason, snippet, violation.ruleId);

  // Strategy 1: Exact deterministic fingerprint match
  for (const b of baselineViolations) {
    if (b.fingerprint === fingerprint) {
      return b;
    }
  }

  // Strategy 2: Same file + snippet text/hash match (resilient to line number shifts)
  for (const b of baselineViolations) {
    if (b.path === normPath && (b.snippet === snippet || b.snippetHash === snippetHash)) {
      return b;
    }
  }

  // Strategy 3: Same file + exact line + reason match (fallback)
  for (const b of baselineViolations) {
    if (b.path === normPath && b.line === violation.line && b.reason === violation.reason) {
      return b;
    }
  }

  return null;
}

/**
 * Filters file scan results against a baseline document.
 * Violations matching the baseline are marked as "existing" baselineState and suppressed.
 * Violations not in baseline are marked as "new" baselineState and remain active.
 */
export function filterResultsWithBaseline(
  results: FileScanResult[],
  baseline: BaselineFile,
): FilterBaselineResult {
  let baselineSuppressedCount = 0;
  let newViolationCount = 0;

  const filteredResults: FileScanResult[] = results.map((fileResult) => {
    const activeViolations: Violation[] = [];
    const suppressedViolations: Violation[] = [...(fileResult.suppressedViolations || [])];

    for (const v of fileResult.violations) {
      const match = matchViolationAgainstBaseline(v, fileResult.path, baseline.violations);

      if (match) {
        baselineSuppressedCount++;
        const suppressed: Violation = {
          ...v,
          baselineState: "existing",
          suppression: {
            reason: `Matched baseline entry (${match.fingerprint.slice(0, 8)})`,
            line: v.line,
          },
        };
        suppressedViolations.push(suppressed);
      } else {
        newViolationCount++;
        const newViolation: Violation = {
          ...v,
          baselineState: "new",
        };
        activeViolations.push(newViolation);
      }
    }

    return {
      ...fileResult,
      violations: activeViolations,
      ...(suppressedViolations.length > 0 ? { suppressedViolations } : {}),
    };
  });

  return {
    filteredResults,
    results: filteredResults,
    baselineSuppressedCount,
    suppressedCount: baselineSuppressedCount,
    newViolationCount,
    newCount: newViolationCount,
  };
}

/**
 * Updates an existing baseline document with current results:
 * - Retains existing entries that still exist or were not scanned
 * - Appends newly detected entries
 * - Computes added and removed counts
 */
export function updateBaselineWithResults(
  existingBaseline: BaselineFile | null,
  results: FileScanResult[],
  options?: { gitCommit?: string | undefined; toolVersion?: string | undefined },
): UpdateBaselineResult {
  const newBaseline = createBaselineFromResults(results, options);

  if (!existingBaseline || existingBaseline.violations.length === 0) {
    return {
      updatedBaseline: newBaseline,
      addedCount: newBaseline.violations.length,
      removedCount: 0,
    };
  }

  const existingMap = new Map<string, BaselineViolation>(
    existingBaseline.violations.map((v) => [v.fingerprint, v]),
  );
  const currentMap = new Map<string, BaselineViolation>(
    newBaseline.violations.map((v) => [v.fingerprint, v]),
  );

  let addedCount = 0;
  let removedCount = 0;

  for (const [fp] of currentMap) {
    if (!existingMap.has(fp)) {
      addedCount++;
    }
  }

  for (const [fp] of existingMap) {
    if (!currentMap.has(fp)) {
      removedCount++;
    }
  }

  return {
    updatedBaseline: newBaseline,
    addedCount,
    removedCount,
  };
}
