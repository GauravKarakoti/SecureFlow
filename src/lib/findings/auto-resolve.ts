/**
 * Auto-Resolve Findings (#1869)
 *
 * Automatically marks open findings as RESOLVED when a later push to a pull request
 * removes them.
 *
 * Requirements:
 * - After each completed scan of a pull request, compare the new finding fingerprints
 *   with the open findings from earlier scans of the same PR.
 * - Mark open findings whose fingerprint is no longer present (and whose file still exists or was changed)
 *   as RESOLVED, record the resolving commit SHA and time, and keep them in history.
 * - Do not resolve findings from scans that failed, were partial (e.g. some files skipped)
 *   or were dismissed by a user.
 */

import prisma from "@/lib/prisma";
import { sanitizeAuditLogInput } from "@/lib/audit/minimization";
import { invalidateCachedUserFilters } from "@/lib/audit/user-filter-cache";
import { SUPPRESSED_STATUSES } from "@/lib/triage/statuses";
import { extractDiffFileMetadata, type FileRename } from "@/lib/armor/diff";

export interface AutoResolveCandidate {
  fingerprint: string;
  fileLocation: string;
  createdAt: Date;
  resolutionReason?: "fixed" | "file_deleted" | "renamed";
  newLocation?: string;
}

export interface FileChangeItem {
  filename: string;
  status?: string;
  previous_filename?: string;
  patch?: string;
}

export interface AutoResolveOptions {
  repositoryId: string;
  pullRequestId: string;
  headSha?: string | null;
  /** Findings detected in the current scan */
  currentFindings: Array<{ fingerprint?: string; fileLocation?: string }>;
  /** Changed files in this PR/commit */
  fileChanges?: Array<FileChangeItem | { filename: string }>;
  /** Explicit list of renamed files */
  renamedFiles?: FileRename[];
  /** Explicit list of deleted files */
  deletedFiles?: string[];
  /** Whether some files were skipped (e.g. payload too large, deadline exceeded) */
  isPartialScan?: boolean;
  /** Whether the scan failed */
  isFailedScan?: boolean;
  /** Current scan result ID to exclude from previous scans lookup */
  currentScanResultId?: string;
  userId?: string;
  repoFullName?: string;
  /** Injected db client for testing */
  db?: typeof prisma;
}

export interface AutoResolveResult {
  resolvedCount: number;
  resolvedFingerprints: string[];
  skippedDismissedCount: number;
  skippedStillPresentCount: number;
  renamedResolvedCount?: number;
  deletedResolvedCount?: number;
}

/**
 * Normalizes a file path for comparison by removing line numbers, leading `./`, and Windows backslashes.
 */
export function normalizeFilePath(filePath: string): string {
  return filePath.replace(/:.*$/, "").replace(/^\.\//, "").replace(/\\/g, "/").trim().toLowerCase();
}

/**
 * Evaluates whether open findings from earlier scans of the same PR have disappeared,
 * and if so, marks them as RESOLVED with the resolving commit SHA and timestamp.
 */
export async function autoResolveFixedFindings(
  options: AutoResolveOptions,
): Promise<AutoResolveResult> {
  const {
    repositoryId,
    pullRequestId,
    headSha,
    currentFindings = [],
    fileChanges = [],
    isPartialScan = false,
    isFailedScan = false,
    currentScanResultId,
    userId,
    repoFullName = "",
    db = prisma,
  } = options;

  // Rule 1: Failed or partial scans NEVER resolve findings
  if (isFailedScan || isPartialScan) {
    return {
      resolvedCount: 0,
      resolvedFingerprints: [],
      skippedDismissedCount: 0,
      skippedStillPresentCount: 0,
    };
  }

  // Without a commit SHA or pull request ID, we cannot attribute the resolution
  if (!headSha || !pullRequestId || !repositoryId) {
    return {
      resolvedCount: 0,
      resolvedFingerprints: [],
      skippedDismissedCount: 0,
      skippedStillPresentCount: 0,
    };
  }

  // Set of current finding fingerprints
  const currentFingerprints = new Set(
    currentFindings.map((f) => f.fingerprint).filter((fp): fp is string => Boolean(fp)),
  );

  // Look up earlier scans for this PR
  const earlierScans = await db.scanResult.findMany({
    where: {
      pullRequestId,
      ...(currentScanResultId ? { id: { not: currentScanResultId } } : {}),
    },
    include: {
      findings: {
        select: {
          fingerprint: true,
          fileLocation: true,
          createdAt: true,
        },
      },
    },
    orderBy: { createdAt: "desc" },
  });

  if (!earlierScans || earlierScans.length === 0) {
    return {
      resolvedCount: 0,
      resolvedFingerprints: [],
      skippedDismissedCount: 0,
      skippedStillPresentCount: 0,
    };
  }

  // Deduplicate earlier findings by fingerprint
  const earlierFindingsMap = new Map<string, AutoResolveCandidate>();
  for (const scan of earlierScans) {
    for (const f of scan.findings) {
      if (f.fingerprint && !earlierFindingsMap.has(f.fingerprint)) {
        earlierFindingsMap.set(f.fingerprint, {
          fingerprint: f.fingerprint,
          fileLocation: f.fileLocation,
          createdAt: f.createdAt,
        });
      }
    }
  }

  if (earlierFindingsMap.size === 0) {
    return {
      resolvedCount: 0,
      resolvedFingerprints: [],
      skippedDismissedCount: 0,
      skippedStillPresentCount: 0,
    };
  }

  // Populate renames and deletions (#2052)
  const renameMap = new Map<string, string>(); // oldNormalizedPath -> newNormalizedPath
  const deletedFilePaths = new Set<string>();

  if (options.renamedFiles) {
    for (const r of options.renamedFiles) {
      renameMap.set(normalizeFilePath(r.from), normalizeFilePath(r.to));
    }
  }
  if (options.deletedFiles) {
    for (const d of options.deletedFiles) {
      deletedFilePaths.add(normalizeFilePath(d));
    }
  }

  for (const fc of fileChanges as FileChangeItem[]) {
    if (fc.previous_filename) {
      renameMap.set(normalizeFilePath(fc.previous_filename), normalizeFilePath(fc.filename));
    }
    if (fc.status === "removed" || fc.status === "deleted") {
      deletedFilePaths.add(normalizeFilePath(fc.filename));
    }
    if (fc.patch) {
      const meta = extractDiffFileMetadata(fc.patch);
      for (const r of meta.renamedFiles) {
        renameMap.set(normalizeFilePath(r.from), normalizeFilePath(r.to));
      }
      for (const d of meta.deletedFiles) {
        deletedFilePaths.add(normalizeFilePath(d));
      }
    }
  }

  // Changed files set for path relevance check
  const changedFilePaths = new Set(fileChanges.map((fc) => normalizeFilePath(fc.filename)));
  for (const d of deletedFilePaths) {
    changedFilePaths.add(d);
  }
  for (const from of renameMap.keys()) {
    changedFilePaths.add(from);
  }

  // Find findings that disappeared in this scan
  const disappearedCandidates: AutoResolveCandidate[] = [];
  let skippedStillPresentCount = 0;

  for (const [fingerprint, candidate] of earlierFindingsMap) {
    if (currentFingerprints.has(fingerprint)) {
      skippedStillPresentCount++;
      continue;
    }

    const normalizedLocation = normalizeFilePath(candidate.fileLocation);
    const isDeleted = deletedFilePaths.has(normalizedLocation);
    const renameTarget = renameMap.get(normalizedLocation);

    if (isDeleted) {
      // File was deleted in this commit/PR, so finding is resolved via deletion (#2052)
      disappearedCandidates.push({
        ...candidate,
        resolutionReason: "file_deleted",
      });
      continue;
    }

    if (renameTarget) {
      // File was renamed to renameTarget (#2052)
      disappearedCandidates.push({
        ...candidate,
        resolutionReason: "renamed",
        newLocation: renameTarget,
      });
      continue;
    }

    // Verify file still exists or was changed in this PR diff
    if (changedFilePaths.size > 0) {
      const isFileInDiff = changedFilePaths.has(normalizedLocation);
      if (!isFileInDiff) {
        // If the file was not part of the changed files in this scan, do not auto-resolve
        continue;
      }
    }

    disappearedCandidates.push({
      ...candidate,
      resolutionReason: "fixed",
    });
  }

  if (disappearedCandidates.length === 0) {
    return {
      resolvedCount: 0,
      resolvedFingerprints: [],
      skippedDismissedCount: 0,
      skippedStillPresentCount,
    };
  }

  // Fetch triage status for all candidates
  const candidateFingerprints = disappearedCandidates.map((c) => c.fingerprint);
  const triageRecords: Array<{ fingerprint: string; status: string }> =
    (await db.findingTriage.findMany({
      where: {
        repositoryId,
        fingerprint: { in: candidateFingerprints },
      },
      select: {
        fingerprint: true,
        status: true,
      },
    })) as any;

  const triageMap = new Map<string, { fingerprint: string; status: string }>(
    triageRecords.map((t) => [t.fingerprint, t]),
  );
  const suppressedSet = new Set<string>(SUPPRESSED_STATUSES);

  const resolvedFingerprints: string[] = [];
  let skippedDismissedCount = 0;
  let renamedResolvedCount = 0;
  let deletedResolvedCount = 0;
  const now = new Date();
  const shortSha = headSha.slice(0, 7);

  for (const candidate of disappearedCandidates) {
    const existingTriage = triageMap.get(candidate.fingerprint);

    // Rule 2: Dismissed findings keep their dismissed status (never auto-resolved)
    if (existingTriage && suppressedSet.has(existingTriage.status)) {
      skippedDismissedCount++;
      continue;
    }

    // If already marked as RESOLVED, no need to re-resolve
    if (existingTriage && existingTriage.status === "RESOLVED") {
      continue;
    }

    let resolutionNote = `Resolved by commit ${shortSha}`;
    if (candidate.resolutionReason === "file_deleted") {
      resolutionNote = `Resolved: file deleted by commit ${shortSha}`;
      deletedResolvedCount++;
    } else if (candidate.resolutionReason === "renamed" && candidate.newLocation) {
      resolutionNote = `Resolved: file renamed to ${candidate.newLocation} by commit ${shortSha}`;
      renamedResolvedCount++;
    }

    // Mark as RESOLVED with resolving commit SHA and timestamp
    await db.findingTriage.upsert({
      where: {
        repositoryId_fingerprint: {
          repositoryId,
          fingerprint: candidate.fingerprint,
        },
      },
      create: {
        repositoryId,
        fingerprint: candidate.fingerprint,
        status: "RESOLVED",
        resolvedAt: now,
        resolvedCommitSha: headSha,
        note: resolutionNote,
      },
      update: {
        status: "RESOLVED",
        resolvedAt: now,
        resolvedCommitSha: headSha,
        note: resolutionNote,
      },
    });

    resolvedFingerprints.push(candidate.fingerprint);

    // Record audit log entry
    if (userId) {
      await db.auditLog.create({
        data: sanitizeAuditLogInput({
          userId,
          action: "Finding Resolved",
          resource: `${repoFullName || repositoryId}:${candidate.fingerprint.slice(0, 12)}`,
          decision: "RESOLVED",
          metadata: {
            repositoryId,
            fingerprint: candidate.fingerprint,
            pullRequestId,
            fileLocation: candidate.fileLocation,
            ...(candidate.newLocation ? { renamedTo: candidate.newLocation } : {}),
            resolutionReason: candidate.resolutionReason,
            resolvedCommitSha: headSha,
            resolvedAt: now.toISOString(),
            previousStatus: existingTriage?.status ?? "OPEN",
            autoResolved: true,
          },
        }),
      });
    }
  }

  if (userId && resolvedFingerprints.length > 0) {
    invalidateCachedUserFilters(userId);
  }

  return {
    resolvedCount: resolvedFingerprints.length,
    resolvedFingerprints,
    skippedDismissedCount,
    skippedStillPresentCount,
    renamedResolvedCount,
    deletedResolvedCount,
  };
}
