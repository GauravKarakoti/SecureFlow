import { severityBadge } from "@/lib/severity";

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

export interface ScanReportSummaryInput {
  /** The findings to write out in this comment. */
  findings: readonly ScanReportFinding[];
  /** Every finding reported on the PR, including those annotated inline. */
  totalFindings: number;
  /** How many findings were posted as inline review comments. */
  inlineCount: number;
  /** Partial-coverage notice from `formatCoverageNotice`, if any. */
  coverageNotice?: string | null;
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
}: ScanReportSummaryInput): string {
  let body = `### 🛡️ SecureFlow AI Security Report\n\n`;
  body += `⚠️ Detected **${totalFindings}** potential issues matching your code policies. Please review them before merging.\n\n`;

  if (coverageNotice) {
    body += `${coverageNotice}\n\n`;
  }

  if (inlineCount > 0 && findings.length < totalFindings) {
    body += `📍 **${inlineCount}** finding(s) are annotated inline on the exact changed lines below.\n\n`;
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

  return body;
}
