/**
 * GitHub Suggested Changes for Inline PR Review Comments (#2005)
 *
 * Formats findings with clean single-line or few-line safe replacements as
 * GitHub ```suggestion blocks on the exact diff lines, allowing reviewers
 * to apply the fix with one click directly in GitHub.
 *
 * Constraints & Guarantees:
 *  - Only lines inside the PR diff receive suggestions.
 *  - Skip multi-file or ambiguous fixes.
 *  - Never include secret values or credentials.
 *  - Per-PR limit is strictly enforced.
 *  - Opt-in per repository via `.secureflow.json`.
 */

import { severityBadge } from "@/lib/severity";
import { SECRET_FAMILIES } from "@/lib/armor/secret-detector";
import type { ScanFinding } from "@/lib/armor/scanner";
import type { EnrichedScanFinding } from "@/lib/scanner/scan-persistence";
import {
  type SuggestionsConfig,
  DEFAULT_MAX_SUGGESTIONS,
  resolveSuggestionsConfig,
} from "@/lib/scanner/gate-config";

export { type SuggestionsConfig, DEFAULT_MAX_SUGGESTIONS, resolveSuggestionsConfig };

export interface InlineComment {
  path: string;
  line: number;
  start_line?: number;
  start_side?: "RIGHT";
  side?: "RIGHT";
  body: string;
  hasSuggestion?: boolean;
}

export interface BuildInlineCommentsResult {
  inlineComments: InlineComment[];
  summaryFindings: (ScanFinding | EnrichedScanFinding)[];
  suggestionsAppliedCount: number;
}

/**
 * Checks if text contains obvious secret values or markers that should never
 * be suggested as code changes.
 */
export function containsSecretValues(text: string): boolean {
  if (!text) return false;
  if (/\[REDACTED\]|\*{3,}|<REDACTED>/i.test(text)) return true;

  for (const family of SECRET_FAMILIES) {
    family.pattern.lastIndex = 0;
    if (family.pattern.test(text)) {
      return true;
    }
  }

  return false;
}

/**
 * Checks whether a proposed fix is ambiguous or conversational rather than a
 * concrete, safe replacement.
 */
export function isAmbiguousFix(text: string): boolean {
  if (!text) return true;

  const ambiguousPatterns = [
    /\beither\b.*?\bor\b/i,
    /\bcould\s+(?:also|be)\b/i,
    /\bdepending\s+on\b/i,
    /\bconsider\s+(?:using|rotating|switching|evaluating)\b/i,
    /\balternatively\b/i,
    /\bfor\s+example\b/i,
    /\be\.g\.\b/i,
    /\bsuch\s+as\b/i,
    /\bone\s+option\b/i,
    /\bTODO\b/i,
    /\bTBD\b/i,
    /\bit\s+depends\b/i,
  ];

  return ambiguousPatterns.some((pattern) => pattern.test(text));
}

/**
 * Checks whether a remediation involves multiple files.
 */
export function isMultiFileFix(text: string): boolean {
  if (!text) return false;

  // Detect patterns like "in file.js ... and also in other.js" or multiple distinct file paths
  if (/\b(?:and\s+also\s+in|across\s+multiple\s+files|in\s+both\s+files)\b/i.test(text)) {
    return true;
  }

  const fileMentionRegex = /\b[a-zA-Z0-9_\-\/]+\.(?:ts|js|jsx|tsx|json|ya?ml|tf|py|go|rb|rs)\b/gi;
  const matches = text.match(fileMentionRegex);
  if (matches && new Set(matches.map((m) => m.toLowerCase())).size > 1) {
    return true;
  }

  return false;
}

/**
 * Extracts a candidate code replacement from finding remediation or fields.
 * Returns null if the fix is multi-file, ambiguous, contains secrets, or exceeds line limits.
 */
export function extractSuggestedReplacement(
  finding: ScanFinding | EnrichedScanFinding,
): string | null {
  // Never include secret values or suggestions for secret findings
  const typeLower = (finding.type || "").toLowerCase();
  if (
    typeLower === "secret" ||
    typeLower.includes("secret") ||
    finding.matchedSignatures?.some((s) => s.toLowerCase().includes("secret"))
  ) {
    return null;
  }

  // Check candidate sources in priority order
  const anyFinding = finding as any;
  const rawCandidate =
    anyFinding.suggestedFix ||
    anyFinding.replacement ||
    anyFinding.oneLineFix ||
    finding.remediation ||
    "";

  if (!rawCandidate || typeof rawCandidate !== "string" || !rawCandidate.trim()) {
    return null;
  }

  // Multi-file check
  if (isMultiFileFix(rawCandidate)) {
    return null;
  }

  // Ambiguity check on the remediation context
  if (isAmbiguousFix(rawCandidate)) {
    return null;
  }

  let codeBlock: string | null = null;

  // 1. Check for explicit ```suggestion ... ```
  const suggestionMatch = rawCandidate.match(/```suggestion\r?\n([\s\S]*?)\r?\n```/i);
  if (suggestionMatch) {
    codeBlock = suggestionMatch[1];
  } else {
    // 2. Check for fenced code block ```lang\n ... ```
    const codeBlockMatch = rawCandidate.match(/```(?:[a-zA-Z0-9_-]+)?\r?\n([\s\S]*?)\r?\n```/);
    if (codeBlockMatch) {
      codeBlock = codeBlockMatch[1];
    } else {
      // 3. Raw replacement (if single or few lines without markdown headers/lists)
      const isPlainCode =
        !rawCandidate.includes("###") &&
        !rawCandidate.includes("- ") &&
        !rawCandidate.includes("\n\n");
      if (isPlainCode) {
        codeBlock = rawCandidate.trim();
      }
    }
  }

  if (!codeBlock || !codeBlock.trim()) {
    return null;
  }

  const cleaned = codeBlock.replace(/\r\n/g, "\n").trimEnd();
  const lines = cleaned.split("\n");

  // Only single-line or few-line replacements (1 to 5 lines)
  if (lines.length < 1 || lines.length > 5) {
    return null;
  }

  // Validate no secret values are present in the replacement code
  if (containsSecretValues(cleaned)) {
    return null;
  }

  return cleaned;
}

/**
 * Formats a replacement string inside a GitHub suggested-change code fence.
 */
export function formatSuggestionBlock(replacement: string): string {
  return "```suggestion\n" + replacement + "\n```";
}

/**
 * Formats the body of an inline review comment, incorporating a ```suggestion block
 * when a clean replacement is available.
 */
export function formatInlineCommentBody(
  finding: ScanFinding | EnrichedScanFinding,
  suggestion?: string | null,
): string {
  const badge = severityBadge(finding.severity as any);
  let body = `**${badge} · ${finding.type}**\n\n`;

  const anyFinding = finding as any;
  if (anyFinding.promptInjectionSuspected) {
    body += `> ⚠️ **AI explanation may be unreliable for this finding — verify manually.** The code snippet associated with this finding triggered prompt-injection heuristics or produced a severity-inconsistent response. Trust the ${badge} badge from the static scanner above the AI narrative.\n\n`;
  }

  const narrative = anyFinding.explanation ?? finding.description;
  if (narrative) {
    body += `${narrative}\n\n`;
  }

  if (suggestion) {
    body += formatSuggestionBlock(suggestion) + "\n\n";
  }

  if (finding.remediation) {
    // If remediation has ```suggestion fences, replace with standard code fences inside <details>
    // so GitHub does not treat details text as an unintentional extra suggestion or suggest changes when disabled.
    const sanitizedRemediation = finding.remediation
      .replace(/```suggestion\r?\n/gi, "```\n")
      .trim();
    body += `<details>\n<summary><b>🛠️ View Remediation Suggestions</b></summary>\n\n${sanitizedRemediation}\n\n</details>`;
  }

  return body;
}

/**
 * Resolves the diff anchor line for a finding, or null if outside the PR diff.
 */
export function resolveAnchorLine(
  finding: ScanFinding | EnrichedScanFinding,
  commentableLines?: Set<number>,
): number | null {
  if (typeof finding.lineStart !== "number" || !commentableLines) {
    return null;
  }

  // Exact line must exist on the new side of the diff
  if (commentableLines.has(finding.lineStart)) {
    return finding.lineStart;
  }

  return null;
}

/**
 * Builds inline review comments from scan findings, applying GitHub suggested changes
 * when enabled, within limits, and strictly on commentable diff lines.
 */
export function buildInlineReviewComments(
  findings: (ScanFinding | EnrichedScanFinding)[],
  commentableLinesByFile: Map<string, Set<number>>,
  options: {
    suggestionsConfig?: SuggestionsConfig;
    maxSuggestions?: number;
  } = {},
): BuildInlineCommentsResult {
  const inlineComments: InlineComment[] = [];
  const summaryFindings: (ScanFinding | EnrichedScanFinding)[] = [];

  const config = options.suggestionsConfig ?? {
    enabled: false,
    maxSuggestions: DEFAULT_MAX_SUGGESTIONS,
  };
  const effectiveLimit = options.maxSuggestions ?? config.maxSuggestions;
  let suggestionsAppliedCount = 0;

  for (const f of findings) {
    const fileLines = commentableLinesByFile.get(f.fileLocation);
    const line = resolveAnchorLine(f, fileLines);

    if (line === null) {
      // Lines outside the diff never receive suggestions or inline review comments
      summaryFindings.push(f);
      continue;
    }

    let suggestion: string | null = null;
    const canSuggest = config.enabled && suggestionsAppliedCount < effectiveLimit;

    if (canSuggest) {
      suggestion = extractSuggestedReplacement(f);
      if (suggestion !== null) {
        suggestionsAppliedCount++;
      }
    }

    const commentBody = formatInlineCommentBody(f, suggestion);
    inlineComments.push({
      path: f.fileLocation,
      line,
      body: commentBody,
      hasSuggestion: suggestion !== null,
    });
  }

  return {
    inlineComments,
    summaryFindings,
    suggestionsAppliedCount,
  };
}

/**
 * Posts an inline review to GitHub with suggested changes and inline comments.
 */
export async function postSuggestedChangesReview(
  octokit: any,
  params: {
    owner: string;
    repo: string;
    pullNumber: number;
    commitId?: string;
    comments: InlineComment[];
    body?: string;
  },
): Promise<{ success: boolean; reviewId?: number; error?: string }> {
  if (!params.comments || params.comments.length === 0) {
    return { success: true };
  }

  try {
    const formattedComments = params.comments.map((c) => ({
      path: c.path,
      line: c.line,
      ...(c.start_line && c.start_line < c.line
        ? { start_line: c.start_line, start_side: "RIGHT" as const, side: "RIGHT" as const }
        : {}),
      body: c.body,
    }));

    const response = await octokit.rest.pulls.createReview({
      owner: params.owner,
      repo: params.repo,
      pull_number: params.pullNumber,
      commit_id: params.commitId,
      event: "COMMENT",
      body: params.body || "🛡️ SecureFlow Automated Security Review",
      comments: formattedComments,
    });

    return { success: true, reviewId: response?.data?.id };
  } catch (err: any) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    return { success: false, error: errorMsg };
  }
}
