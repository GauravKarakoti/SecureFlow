import { severityBadge } from "@/lib/severity";
import { resolvePolicyGuidance } from "@/lib/policies/built-in";
import {
  loadBaseCodeOwners,
  ownersForPath,
  type CodeOwnersBase,
  type CodeOwnersClient,
} from "./codeowners";
import { SECUREFLOW_COMMENT_MARKER, formatScanMetadata } from "./sticky-comment";

export { SECUREFLOW_COMMENT_MARKER, formatScanMetadata };

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
  id?: string;
  severity: unknown;
  type: string;
  fileLocation: string;
  explanation?: string | null;
  remediation?: string | null;
  promptInjectionSuspected?: boolean;
  verifiedPatch?: boolean;
  readyFix?: boolean;
  patchNote?: string;
  policyName?: string | null;
  helpUrl?: string | null;
  guidance?: string | null;
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

export interface ExpiredIgnoreRuleReport {
  pattern: string;
  expires: string;
  reason?: string;
}

export interface AppliedPolicyScopeReport {
  paths: string[];
  enable?: string[];
  disable?: string[];
  matchedFiles?: string[];
  fileCount?: number;
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
  /** Findings suppressed by installation-wide suppression rules (#1891). */
  ruleSuppressedCount?: number;
  /** Scanned commit SHA to show in the report. */
  commitSha?: string | null;
  /** Scan timestamp to show in the report. */
  scanTime?: string | Date | null;
  /** Ignore rules (.secureflowignore) that have expired. */
  expiredIgnoreRules?: readonly ExpiredIgnoreRuleReport[];
  /** Policy scopes applied to changed files (#1868). */
  appliedPolicyScopes?: readonly AppliedPolicyScopeReport[];
  /** Number of files skipped by built-in default ignore patterns (#1983). */
  defaultSkippedCount?: number;
  ownership?: {
    byPath: ReadonlyMap<string, readonly string[]>;
    inlinePaths: readonly string[];
  };
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

function formatOwners(owners: readonly string[] | undefined): string {
  return owners?.length ? owners.map(toCodeSpan).join(", ") : "Unowned";
}

function renderOwnershipSummary(
  findings: readonly ScanReportFinding[],
  { byPath, inlinePaths }: NonNullable<ScanReportSummaryInput["ownership"]>,
): string {
  const owners = new Map<string, number>();
  for (const path of [...findings.map((finding) => finding.fileLocation), ...inlinePaths]) {
    const assigned = byPath.get(path);
    for (const owner of assigned?.length ? assigned : ["Unowned"]) {
      owners.set(owner, (owners.get(owner) ?? 0) + 1);
    }
  }

  if (owners.size === 0) return "";
  const counts = [...owners]
    .map(([owner, count]) => `${owner === "Unowned" ? owner : toCodeSpan(owner)} (${count})`)
    .join(", ");
  let body = `**By owner:** ${counts}\n\n`;
  if (inlinePaths.length) {
    const paths = new Map<string, number>();
    for (const path of inlinePaths) paths.set(path, (paths.get(path) ?? 0) + 1);
    body += "#### Owners of findings posted inline\n\n";
    for (const [path, count] of paths) {
      body += `- ${toCodeSpan(path)} (${count}) — ${formatOwners(byPath.get(path))}\n`;
    }
    body += "\n";
  }
  return body;
}

export function renderScanReportSummary({
  findings,
  totalFindings,
  inlineCount,
  coverageNotice,
  suppressedFindings = [],
  rejectedSuppressions = [],
  previouslyDismissedCount = 0,
  ruleSuppressedCount = 0,
  commitSha,
  scanTime,
  expiredIgnoreRules = [],
  appliedPolicyScopes = [],
  defaultSkippedCount = 0,
  ownership,
}: ScanReportSummaryInput): string {
  const appUrl = (process.env.NEXT_PUBLIC_APP_URL || "").replace(/\/+$/, "");
  let body = `${SECUREFLOW_COMMENT_MARKER}\n### 🛡️ SecureFlow AI Security Report\n\n`;

  body += formatScanMetadata({ commitSha, scanTime });

  body += `⚠️ Detected **${totalFindings}** potential issues matching your code policies. Please review them before merging.\n\n`;

  if (defaultSkippedCount > 0) {
    body += `ℹ️ **${defaultSkippedCount} file${defaultSkippedCount === 1 ? "" : "s"}** skipped by default ignore patterns.\n\n`;
  }

  if (appliedPolicyScopes && appliedPolicyScopes.length > 0) {
    body += `### 📁 Policy Scopes Applied (${appliedPolicyScopes.length})\n\n`;
    for (const scope of appliedPolicyScopes) {
      const pathGlobs = scope.paths.map((p) => `\`${p}\``).join(", ");
      const count = scope.fileCount ?? scope.matchedFiles?.length ?? 0;
      const countText = count > 0 ? ` (${count} file${count === 1 ? "" : "s"})` : "";
      const parts: string[] = [];
      if (scope.enable && scope.enable.length > 0) {
        parts.push(`Enabled **${scope.enable.join("**, **")}**`);
      }
      if (scope.disable && scope.disable.length > 0) {
        parts.push(`Disabled **${scope.disable.join("**, **")}**`);
      }
      body += `- ${pathGlobs}: ${parts.join("; ")}${countText}\n`;
    }
    body += `\n`;
  }

  if (previouslyDismissedCount > 0) {
    body += `🛡️ **${previouslyDismissedCount} previously dismissed** finding(s) were suppressed for this repository.\n\n`;
  }

  if (ruleSuppressedCount > 0) {
    body += `🛡️ **${ruleSuppressedCount}** finding(s) were suppressed by installation suppression rule(s).\n\n`;
  }

  if (coverageNotice) {
    body += `${coverageNotice}\n\n`;
  }

  if (inlineCount > 0 && findings.length < totalFindings) {
    body += `📍 **${inlineCount}** finding(s) are annotated inline on the exact changed lines below.\n\n`;
  }

  if (ownership) body += renderOwnershipSummary(findings, ownership);

  if (suppressedFindings.length > 0) {
    body += `🔕 **${suppressedFindings.length}** finding(s) suppressed via inline directives.\n\n`;
  }

  if (rejectedSuppressions.length > 0) {
    body += `⚠️ **${rejectedSuppressions.length}** inline suppression directive(s) rejected or ignored.\n\n`;
  }

  for (const f of findings) {
    body += `#### ${severityBadge(f.severity)} | **${f.type}** in ${toCodeSpan(f.fileLocation)}\n`;
    if (ownership) body += `**Owners:** ${formatOwners(ownership.byPath.get(f.fileLocation))}\n\n`;
    if (f.id) {
      body += `🔗 [View Finding Details](${appUrl}/dashboard/findings/${f.id})\n\n`;
    }
    const policyInfo = resolvePolicyGuidance(f);
    const helpUrl = f.helpUrl || policyInfo.helpUrl;
    const guidance = f.guidance || policyInfo.guidance;
    if (helpUrl) {
      body += `📖 [How to fix](${helpUrl})${guidance ? ` — ${guidance}` : ""}\n\n`;
    }
    if (f.promptInjectionSuspected) {
      body += INJECTION_WARNING(f.severity);
    }
    body += `${toBlockquote(f.explanation ?? "")}\n\n`;
    const patchBadge = f.verifiedPatch ? " (Verified Ready Fix)" : "";
    body += `<details>\n<summary><b>🛠️ View Remediation Suggestions${patchBadge}</b></summary>\n\n`;
    body += `${f.remediation ?? ""}\n\n`;
    if (f.patchNote) {
      body += `> ℹ️ ${f.patchNote}\n\n`;
    }
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

  if (expiredIgnoreRules.length > 0) {
    body += `### ⚠️ Expired Ignore Rules (${expiredIgnoreRules.length})\n\n`;
    for (const rule of expiredIgnoreRules) {
      const reasonText = rule.reason ? ` — reason: ${rule.reason}` : "";
      body += `- ⚠️ ignore rule \`${rule.pattern}\` expired on ${rule.expires}${reasonText}\n`;
    }
    body += `\n`;
  }

  return body;
}

export async function renderScanReportWithBaseOwners(
  client: CodeOwnersClient,
  base: CodeOwnersBase,
  input: ScanReportSummaryInput,
  inlinePaths: readonly string[],
): Promise<string> {
  const rules = await loadBaseCodeOwners(client, base);
  if (!rules) return renderScanReportSummary(input);

  const paths = new Set([...input.findings.map((finding) => finding.fileLocation), ...inlinePaths]);
  const byPath = new Map([...paths].map((path) => [path, ownersForPath(rules, path)]));
  const annotated = renderScanReportSummary({ ...input, ownership: { byPath, inlinePaths } });
  // Keep the existing report usable if the optional labels exceed the GitHub body limit.
  return Buffer.byteLength(annotated) <= 65_536 ? annotated : renderScanReportSummary(input);
}
