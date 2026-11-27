/**
 * Unified Diff Patch Conflict Detector & Fuzzy Offset Auto-Remediation Applier.
 *
 * Parses unified diff hunks, detects overlapping or out-of-bounds hunks,
 * supports bounded fuzzy line-offset matching when surrounding context has shifted,
 * and returns structured conflict diagnostics without mutating source content.
 */

export interface DiffHunkLine {
  type: "context" | "add" | "remove";
  text: string;
}

export interface ParsedDiffHunk {
  index: number;
  header: string;
  oldStart: number;
  oldCount: number;
  newStart: number;
  newCount: number;
  lines: DiffHunkLine[];
}

export interface ParsedUnifiedDiff {
  oldPath?: string;
  newPath?: string;
  hunks: ParsedDiffHunk[];
  parseError?: string;
}

export interface AppliedHunkRecord {
  hunkIndex: number;
  expectedLine: number;
  appliedLine: number;
  offset: number;
}

export type PatchConflictReason =
  | "empty_patch"
  | "missing_hunks"
  | "header_mismatch"
  | "overlapping_hunks"
  | "out_of_bounds"
  | "context_mismatch";

export interface PatchConflict {
  hunkIndex: number;
  reason: PatchConflictReason;
  expectedLine: number;
  message: string;
}

export interface FuzzyPatchApplyOptions {
  expectedFilePath?: string;
  maxFuzzyOffset?: number;
  dryRun?: boolean;
}

export interface FuzzyPatchApplyResult {
  success: boolean;
  dryRun: boolean;
  patchedContent?: string;
  appliedHunks: AppliedHunkRecord[];
  conflicts: PatchConflict[];
}

function normalizeHeaderPath(headerLine: string): string {
  return headerLine
    .slice(4)
    .trim()
    .split("\t", 1)[0]
    .replace(/^a\/|^b\//, "")
    .replace(/\\/g, "/")
    .replace(/^\.\//, "");
}

/**
 * Parse a unified diff string into structured file headers and hunks.
 */
export function parseUnifiedDiff(patch: string): ParsedUnifiedDiff {
  if (!patch || !patch.trim()) {
    return { hunks: [], parseError: "Empty patch provided" };
  }

  const normalized = patch.replace(/\r\n/g, "\n");
  const rawLines = normalized.split("\n");
  if (rawLines.at(-1) === "") {
    rawLines.pop();
  }

  let oldPath: string | undefined;
  let newPath: string | undefined;
  const hunks: ParsedDiffHunk[] = [];

  let currentHunk: ParsedDiffHunk | null = null;

  for (const line of rawLines) {
    if (!currentHunk && line.startsWith("--- ")) {
      oldPath = normalizeHeaderPath(line);
      continue;
    }
    if (!currentHunk && line.startsWith("+++ ")) {
      newPath = normalizeHeaderPath(line);
      continue;
    }

    const hunkMatch = line.match(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/);
    if (hunkMatch) {
      currentHunk = {
        index: hunks.length,
        header: line,
        oldStart: Number(hunkMatch[1]),
        oldCount: hunkMatch[2] === undefined ? 1 : Number(hunkMatch[2]),
        newStart: Number(hunkMatch[3]),
        newCount: hunkMatch[4] === undefined ? 1 : Number(hunkMatch[4]),
        lines: [],
      };
      hunks.push(currentHunk);
      continue;
    }

    if (!currentHunk) {
      continue;
    }

    if (line.startsWith("\\ No newline at end of file")) {
      continue;
    }

    if (line.startsWith("+")) {
      currentHunk.lines.push({ type: "add", text: line.slice(1) });
    } else if (line.startsWith("-")) {
      currentHunk.lines.push({ type: "remove", text: line.slice(1) });
    } else if (line.startsWith(" ")) {
      currentHunk.lines.push({ type: "context", text: line.slice(1) });
    } else {
      return {
        oldPath,
        newPath,
        hunks,
        parseError: `Malformed diff line inside hunk ${currentHunk.index}: "${line}"`,
      };
    }
  }

  if (hunks.length === 0) {
    return {
      oldPath,
      newPath,
      hunks: [],
      parseError: "Patch contains no unified diff hunks (missing @@ header)",
    };
  }

  return { oldPath, newPath, hunks };
}

function matchesAt(sourceLines: string[], startIndex: number, hunk: ParsedDiffHunk): boolean {
  const expectedOldLines = hunk.lines.filter((l) => l.type !== "add");
  if (startIndex < 0 || startIndex + expectedOldLines.length > sourceLines.length) {
    return false;
  }
  for (let i = 0; i < expectedOldLines.length; i++) {
    if (sourceLines[startIndex + i] !== expectedOldLines[i].text) {
      return false;
    }
  }
  return true;
}

function findMatchingIndex(
  sourceLines: string[],
  targetIndex: number,
  minIndex: number,
  hunk: ParsedDiffHunk,
  maxFuzzyOffset: number,
): { matchedIndex: number; offset: number } | null {
  if (targetIndex >= minIndex && matchesAt(sourceLines, targetIndex, hunk)) {
    return { matchedIndex: targetIndex, offset: 0 };
  }

  for (let delta = 1; delta <= maxFuzzyOffset; delta++) {
    const forward = targetIndex + delta;
    if (forward >= minIndex && matchesAt(sourceLines, forward, hunk)) {
      return { matchedIndex: forward, offset: delta };
    }
    const backward = targetIndex - delta;
    if (backward >= minIndex && matchesAt(sourceLines, backward, hunk)) {
      return { matchedIndex: backward, offset: -delta };
    }
  }

  return null;
}

/**
 * Apply a unified diff patch with conflict detection and bounded fuzzy line-offset matching.
 */
export function applyUnifiedPatchWithConflictDetection(
  source: string,
  patch: string,
  options: FuzzyPatchApplyOptions = {},
): FuzzyPatchApplyResult {
  const dryRun = options.dryRun ?? false;
  const maxFuzzyOffset = Math.max(0, options.maxFuzzyOffset ?? 10);

  const parsed = parseUnifiedDiff(patch);
  if (parsed.parseError) {
    return {
      success: false,
      dryRun,
      appliedHunks: [],
      conflicts: [
        {
          hunkIndex: 0,
          reason: !patch || !patch.trim() ? "empty_patch" : "missing_hunks",
          expectedLine: 1,
          message: parsed.parseError,
        },
      ],
    };
  }

  if (options.expectedFilePath && parsed.oldPath && parsed.oldPath !== "/dev/null") {
    const normExpected = options.expectedFilePath.replace(/\\/g, "/").replace(/^\.\//, "");
    if (!normExpected.endsWith(parsed.oldPath) && !parsed.oldPath.endsWith(normExpected)) {
      return {
        success: false,
        dryRun,
        appliedHunks: [],
        conflicts: [
          {
            hunkIndex: 0,
            reason: "header_mismatch",
            expectedLine: 1,
            message: `Patch header target '${parsed.oldPath}' does not match '${normExpected}'`,
          },
        ],
      };
    }
  }

  const sourceHasTrailingNewline = source.endsWith("\n");
  const sourceLines = source.replace(/\r\n/g, "\n").split("\n");
  if (sourceHasTrailingNewline) {
    sourceLines.pop();
  }

  // Pre-check for overlapping hunk ranges in the diff itself
  for (let i = 1; i < parsed.hunks.length; i++) {
    const prev = parsed.hunks[i - 1];
    const curr = parsed.hunks[i];
    const prevEnd = prev.oldStart + Math.max(0, prev.oldCount - 1);
    if (curr.oldStart <= prevEnd && prev.oldCount > 0 && curr.oldCount > 0) {
      return {
        success: false,
        dryRun,
        appliedHunks: [],
        conflicts: [
          {
            hunkIndex: curr.index,
            reason: "overlapping_hunks",
            expectedLine: curr.oldStart,
            message: `Hunk ${curr.index} (line ${curr.oldStart}) overlaps with hunk ${prev.index}`,
          },
        ],
      };
    }
  }

  const outputLines: string[] = [];
  const appliedHunks: AppliedHunkRecord[] = [];
  const conflicts: PatchConflict[] = [];
  let sourceCursor = 0;

  for (const hunk of parsed.hunks) {
    const targetIndex = hunk.oldStart === 0 ? 0 : hunk.oldStart - 1;
    if (targetIndex > sourceLines.length + maxFuzzyOffset) {
      conflicts.push({
        hunkIndex: hunk.index,
        reason: "out_of_bounds",
        expectedLine: hunk.oldStart,
        message: `Hunk ${hunk.index} targets line ${hunk.oldStart}, exceeding file length ${sourceLines.length}`,
      });
      continue;
    }

    const match = findMatchingIndex(sourceLines, targetIndex, sourceCursor, hunk, maxFuzzyOffset);
    if (!match) {
      conflicts.push({
        hunkIndex: hunk.index,
        reason: "context_mismatch",
        expectedLine: hunk.oldStart,
        message: `Context mismatch for hunk ${hunk.index} near line ${hunk.oldStart} (fuzzy ±${maxFuzzyOffset})`,
      });
      continue;
    }

    while (sourceCursor < match.matchedIndex) {
      outputLines.push(sourceLines[sourceCursor]);
      sourceCursor++;
    }

    for (const line of hunk.lines) {
      if (line.type === "context") {
        outputLines.push(sourceLines[sourceCursor]);
        sourceCursor++;
      } else if (line.type === "remove") {
        sourceCursor++;
      } else {
        outputLines.push(line.text);
      }
    }

    appliedHunks.push({
      hunkIndex: hunk.index,
      expectedLine: hunk.oldStart,
      appliedLine: match.matchedIndex + 1,
      offset: match.offset,
    });
  }

  if (conflicts.length > 0) {
    return {
      success: false,
      dryRun,
      appliedHunks: [],
      conflicts,
    };
  }

  while (sourceCursor < sourceLines.length) {
    outputLines.push(sourceLines[sourceCursor]);
    sourceCursor++;
  }

  let patchedContent = outputLines.join("\n");
  if (sourceHasTrailingNewline || (outputLines.length > 0 && patch.endsWith("\n"))) {
    patchedContent += "\n";
  }

  return {
    success: true,
    dryRun,
    patchedContent,
    appliedHunks,
    conflicts: [],
  };
}
