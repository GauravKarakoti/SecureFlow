import { ignoreReasonFor, compileIgnorePatterns } from "@/lib/armor/ignore-rules";
import { SECUREFLOW_COMMENT_MARKER } from "@/lib/github/sticky-comment";

export type ZeroScanReason = "no changed files" | "unsupported file types" | "all paths ignored";

export interface PullRequestFileLike {
  filename: string;
  status?: string;
  patch?: string;
  [key: string]: unknown;
}

/**
 * Determine the specific reason why analyzed file count is 0:
 *  - "no changed files": empty diff or all files were deleted (removed)
 *  - "all paths ignored": all changed files were excluded by directory/custom ignore rules
 *  - "unsupported file types": all files have unsupported extensions or missing patches (binary)
 */
export function getZeroScanReason(
  files: readonly PullRequestFileLike[],
  customIgnores: RegExp[] | string[] = [],
): ZeroScanReason {
  const nonRemoved = files.filter((f) => f.status !== "removed");
  if (nonRemoved.length === 0) {
    return "no changed files";
  }

  const compiled =
    customIgnores.length > 0 && typeof customIgnores[0] === "string"
      ? compileIgnorePatterns(customIgnores as string[])
      : (customIgnores as RegExp[]);

  let pathIgnoredCount = 0;
  let unsupportedCount = 0;

  for (const file of nonRemoved) {
    const hasPatch = typeof file.patch === "string" && file.patch.trim().length > 0;
    const reason = ignoreReasonFor(file.filename, compiled);

    if (!hasPatch) {
      unsupportedCount++;
    } else if (reason === "extension") {
      unsupportedCount++;
    } else if (
      reason === "directory" ||
      reason === "custom" ||
      reason === "config-file" ||
      reason === "default"
    ) {
      pathIgnoredCount++;
    } else {
      unsupportedCount++;
    }
  }

  if (pathIgnoredCount > 0) {
    return "all paths ignored";
  }

  return "unsupported file types";
}

/**
 * Format the neutral PR comment body for a scan that had 0 analyzed files.
 * Guarantees that zero analyzed files never produces the success wording.
 */
export function formatZeroScanComment(
  reason: ZeroScanReason,
  options: {
    commitSha?: string;
    cleanDismissedNotice?: string;
    cleanRuleNotice?: string;
    cleanExpiredNotice?: string;
    coverageNotice?: string;
    defaultSkippedNotice?: string;
  } = {},
): string {
  return (
    `${SECUREFLOW_COMMENT_MARKER}\n### 🛡️ SecureFlow AI Security Report\n\n` +
    (options.commitSha ? `Scanned commit: \`${options.commitSha}\`\n\n` : "") +
    `⚪ Nothing to scan: ${reason}.` +
    (options.cleanDismissedNotice || "") +
    (options.cleanRuleNotice || "") +
    (options.cleanExpiredNotice || "") +
    (options.defaultSkippedNotice ? `\n\n${options.defaultSkippedNotice}` : "") +
    (options.coverageNotice ? `\n\n${options.coverageNotice}` : "")
  );
}
