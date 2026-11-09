import { severityBadge } from "@/lib/severity";
import { SECUREFLOW_COMMENT_MARKER } from "./sticky-comment";

export { SECUREFLOW_COMMENT_MARKER };

/**
 * The summary comment the webhook worker posts on a pull request.
 *
 * Moved out of the worker's job handler, where it was an inline closure that
 * no test could reach, to fix two rendering defects:
 *
 *  - The explanation was quoted as `> ${explanation}`. A Markdown blockquote
 *    ends at the first blank line, and the model's explanations are usually
 *    several paragraphs, so only the first paragraph was quoted and the rest
 *    ran on as ordinary text, visually merged with the heading of the next
 *    finding.
 *  - The file path was wrapped in a fixed pair of backticks, so a path
 *    containing one (legal in git) closed the code span early.
 */

export interface ScanReportFinding {
  severity: unknown;
  type: string;
  fileLocation: string;
  explanation?: string | null;
  remediation?: string | null;
  promptInjectionSuspected?: boolean;
}

export interface SuppressedFindingReport {
  severity: unknown;
  type: string;
  fileLocation: string;
  line?: number;
  reason: string;
  expires?: string;
}

export interface RejectedSuppressionReport {
  fileLocation: string;
  line?: number;
  reason: string;
  findingType?: string;
  severity?: unknown;
}

export interface ScanReportSummaryInput {
  /** The findings to write out in this comment. */
  findings: readonly ScanReportFinding[];
  /** Every finding reported on the PR, including those annotated inline. */
  totalFindings: number;
  /** How many findings were posted as inline review comments. */
  inlineCount: number;
  /** Partial-coverage notice from `formatCoverageNotice`, if any. */
  coverageNotice?: string | null;
  /** Findings suppressed via inline directives. */
  suppressedFindings?: readonly SuppressedFindingReport[];
  /** Inline suppression directives that were rejected or ignored. */
  rejectedSuppressions?: readonly RejectedSuppressionReport[];
  /** Previously triaged/dismissed findings on this repository suppressed during the scan. */
  previouslyDismissedCount?: number;
  /** Scanned commit SHA to show in the report. */
  commitSha?: string | null;
}

/** Quote every line of `text`, so a multi-paragraph value stays one blockquote. */
export function toBlockquote(text: string): string {
  return text
    .replace(/\r\n?/g, "\n")
    .trim()
    .split("\n")
    .map((line) => (line.trim() === "" ? ">" : `> ${line}`))
    .join("\n");
}

/**
 * Wrap `value` in a code span that survives the content it holds (CommonMark
 * 6.1): the fence is one backtick longer than the longest run inside, padded
 * when the value starts or ends with a backtick.
 */
export function toCodeSpan(value: string): string {
  const text = value.replace(/\r?\n/g, " ");
  const longestRun = Math.max(0, ...[...text.matchAll(/`+/g)].map((m) => m[0].length));
  const fence = "`".repeat(longestRun + 1);
  const padding = text.startsWith("`") || text.endsWith("`") ? " " : "";
  return `${fence}${padding}${text}${padding}${fence}`;
}

const INJECTION_WARNING = (severity: unknown) =>
  `> ⚠️ **AI explanation may be unreliable for this finding — verify manually.** The code snippet triggered prompt-injection heuristics or produced a severity-inconsistent response. Trust the ${severityBadge(severity)} badge from the static scanner above the AI narrative.\n\n`;

export function renderScanReportSummary({
  findings,
  totalFindings,
  inlineCount,
  coverageNotice,
  suppressedFindings = [],
  rejectedSuppressions = [],
  previouslyDismissedCount = 0,
  commitSha,
}: ScanReportSummaryInput): string {
  let body = `${SECUREFLOW_COMMENT_MARKER}\n### 🛡️ SecureFlow AI Security Report\n\n`;

  if (commitSha) {
    body += `Scanned commit: \`${commitSha}\`\n\n`;
  }

  body += `⚠️ Detected **${totalFindings}** potential issues matching your code policies. Please review them before merging.\n\n`;

  if (previouslyDismissedCount > 0) {
    body += `🛡️ **${previouslyDismissedCount} previously dismissed** finding(s) were suppressed for this repository.\n\n`;
  }

  if (coverageNotice) {
    body += `${coverageNotice}\n\n`;
  }

  if (inlineCount > 0 && findings.length < totalFindings) {
    body += `📍 **${inlineCount}** finding(s) are annotated inline on the exact changed lines below.\n\n`;
  }

  if (suppressedFindings.length > 0) {
    body += `🔕 **${suppressedFindings.length}** finding(s) suppressed via inline directives.\n\n`;
  }

  if (rejectedSuppressions.length > 0) {
    body += `⚠️ **${rejectedSuppressions.length}** inline suppression directive(s) rejected or ignored.\n\n`;
  }

  for (const f of findings) {
    body += `#### ${severityBadge(f.severity)} | **${f.type}** in ${toCodeSpan(f.fileLocation)}\n`;
    if (f.promptInjectionSuspected) {
      body += INJECTION_WARNING(f.severity);
    }
    body += `${toBlockquote(f.explanation ?? "")}\n\n`;
    body += `<details>\n<summary><b>🛠️ View Remediation Suggestions</b></summary>\n\n`;
    body += `${f.remediation ?? ""}\n\n`;
    body += `</details>\n\n`;
    body += `---\n\n`;
  }

  if (suppressedFindings.length > 0) {
    body += `### 🔕 Suppressed Findings (${suppressedFindings.length})\n\n`;
    for (const s of suppressedFindings) {
      const loc = s.line ? `${s.fileLocation}:${s.line}` : s.fileLocation;
      const expiryText = s.expires ? ` (expires ${s.expires})` : "";
      body += `- ${severityBadge(s.severity)} | **${s.type}** in ${toCodeSpan(loc)} — reason: ${s.reason}${expiryText}\n`;
    }
    body += `\n`;
  }

  if (rejectedSuppressions.length > 0) {
    body += `### ⚠️ Rejected / Ignored Suppressions (${rejectedSuppressions.length})\n\n`;
    for (const r of rejectedSuppressions) {
      const loc = r.line ? `${r.fileLocation}:${r.line}` : r.fileLocation;
      body += `- Directive in ${toCodeSpan(loc)}: ${r.reason}\n`;
    }
    body += `\n`;
  }

  return body;
}
