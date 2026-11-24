import { checkRunConclusion } from "./scan-persistence";
import { parseSeverity } from "@/lib/severity";
import { maskFindingText } from "@/lib/armor/secret-masking";

/** Branch protection matches on this exact name. Do not rename. */
export const SCAN_CHECK_NAME = "SecureFlow Scan";

/** GitHub Checks API limits output.annotations to 50 items per API call. */
export const ANNOTATION_BATCH_SIZE = 50;

export type AnnotationLevel = "notice" | "warning" | "failure";

export interface CheckAnnotation {
  path: string;
  start_line: number;
  end_line: number;
  start_column?: number;
  end_column?: number;
  annotation_level: AnnotationLevel;
  message: string;
  title?: string;
  raw_details?: string;
}

export type ChecksClient = {
  rest: {
    checks: {
      create: (params: Record<string, unknown>) => Promise<unknown>;
      update?: (params: Record<string, unknown>) => Promise<unknown>;
    };
  };
};

export interface ScanCheckParams {
  owner: string;
  repo: string;
  headSha: string;
  decision: unknown;
  findingsCount: number;
  fileCount: number;
  notice?: string;
  findings?: readonly unknown[] | null;
  checkRunId?: number;
  emptyReason?: string;
  isPartial?: boolean;
  unscannedFiles?: Array<{ filename: string; reason: string }> | string[];
  conclusion?: "success" | "action_required" | "failure" | "neutral" | "skipped";
}

/**
 * Maps finding severity to GitHub Check Run annotation level:
 *  - CRITICAL, HIGH -> failure
 *  - MEDIUM -> warning
 *  - LOW, INFO, NONE -> notice
 */
export function mapSeverityToAnnotationLevel(severity: unknown): AnnotationLevel {
  const parsed = parseSeverity(severity);
  switch (parsed) {
    case "CRITICAL":
    case "HIGH":
      return "failure";
    case "MEDIUM":
      return "warning";
    case "LOW":
    case "NONE":
      return "notice";
    default:
      return "warning";
  }
}

function parsePositiveInteger(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    const int = Math.floor(value);
    return int >= 1 ? int : null;
  }
  if (typeof value === "string" && /^\d+$/.test(value.trim())) {
    const int = parseInt(value.trim(), 10);
    return int >= 1 ? int : null;
  }
  return null;
}

function normalizePath(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const cleaned = raw.replace(/\\/g, "/").replace(/^\.\//, "").replace(/^\/+/, "").trim();
  return cleaned.length > 0 ? cleaned : null;
}

/**
 * Maps a single scanner finding to a GitHub Check Run annotation.
 * Returns null if the finding lacks a valid file or line information.
 * Any secrets in the description or code snippet are masked.
 */
export function findingToAnnotation(finding: unknown): CheckAnnotation | null {
  if (!finding || typeof finding !== "object") return null;

  const f = finding as Record<string, unknown>;

  const path = normalizePath(f.fileLocation ?? f.path ?? f.file ?? f.filename);
  if (!path) return null;

  const rawStart = f.lineStart ?? f.startLine ?? f.start_line ?? f.line;
  const startLine = parsePositiveInteger(rawStart);
  if (startLine === null) return null;

  const rawEnd = f.lineEnd ?? f.endLine ?? f.end_line;
  const parsedEnd = parsePositiveInteger(rawEnd);
  const endLine = parsedEnd !== null && parsedEnd >= startLine ? parsedEnd : startLine;

  const level = mapSeverityToAnnotationLevel(f.severity);

  const rawSnippet =
    typeof f.codeSnippet === "string"
      ? f.codeSnippet
      : typeof f.snippet === "string"
        ? f.snippet
        : "";
  const maskedSnippet = rawSnippet ? maskFindingText(rawSnippet) : "";

  const rawDesc =
    typeof f.description === "string"
      ? f.description
      : typeof f.message === "string"
        ? f.message
        : typeof f.explanation === "string"
          ? f.explanation
          : "";
  const maskedDesc = rawDesc ? maskFindingText(rawDesc) : "";

  const messageParts = [maskedDesc, maskedSnippet].filter(Boolean);
  const message =
    messageParts.length > 0
      ? messageParts.join("\n\n")
      : `${f.type ? maskFindingText(String(f.type)) : "Security"} finding identified.`;

  const annotation: CheckAnnotation = {
    path,
    start_line: startLine,
    end_line: endLine,
    annotation_level: level,
    message,
  };

  const titleRaw = f.type ?? f.title;
  if (typeof titleRaw === "string" && titleRaw.trim()) {
    annotation.title = maskFindingText(titleRaw.trim());
  }

  if (maskedSnippet) {
    annotation.raw_details = maskedSnippet;
  }

  return annotation;
}

export function buildCheckAnnotations(findings?: readonly unknown[] | null): CheckAnnotation[] {
  if (!Array.isArray(findings)) return [];

  const annotations: CheckAnnotation[] = [];
  for (const finding of findings) {
    const annotation = findingToAnnotation(finding);
    if (annotation) {
      annotations.push(annotation);
    }
  }
  return annotations;
}

export function chunkArray<T>(items: readonly T[], chunkSize: number): T[][] {
  if (chunkSize <= 0) return [items.slice()];
  const chunks: T[][] = [];
  for (let i = 0; i < items.length; i += chunkSize) {
    chunks.push(items.slice(i, i + chunkSize));
  }
  return chunks;
}

export async function postScanCheckRun(octokit: ChecksClient, p: ScanCheckParams) {
  const isZeroScan = p.fileCount === 0 || !!p.emptyReason;
  const isPartial = p.isPartial === true;
  const emptyReason = p.emptyReason || "no changed files";

  const annotations = buildCheckAnnotations(p.findings);
  const batches = chunkArray(annotations, ANNOTATION_BATCH_SIZE);
  const firstBatch = batches[0];

  let summary = isZeroScan
    ? `Nothing to scan: ${emptyReason}.` + (p.notice ? `\n\n${p.notice}` : "")
    : `SecureFlow detected ${p.findingsCount} potential security issues across ${p.fileCount} analyzed file(s).` +
      (p.notice ? `\n\n${p.notice}` : "");

  if (isPartial && p.unscannedFiles && p.unscannedFiles.length > 0) {
    summary += `\n\n### ⚠️ Partial Scan — Unscanned Files (${p.unscannedFiles.length})\n`;
    summary += `The scan time budget was reached or files were skipped. The following file(s) were not scanned:\n`;
    for (const f of p.unscannedFiles) {
      const name = typeof f === "string" ? f : f.filename;
      const reason = typeof f === "string" ? "scan timeout budget exceeded" : f.reason;
      summary += `- \`${name}\`: ${reason}\n`;
    }
  }

  const outputTitle = isPartial
    ? `Policy Decision: PARTIAL (${p.findingsCount} issues in ${p.fileCount} analyzed files)`
    : isZeroScan
      ? "Nothing to scan"
      : `Policy Decision: ${String(p.decision)}`;

  const output: {
    title: string;
    summary: string;
    annotations?: CheckAnnotation[];
  } = {
    title: outputTitle,
    summary,
  };

  if (firstBatch && firstBatch.length > 0) {
    output.annotations = firstBatch;
  }

  const conclusion =
    p.conclusion ?? (isZeroScan || isPartial ? "neutral" : checkRunConclusion(p.decision));

  let result: unknown;
  let checkRunId = p.checkRunId;

  if (checkRunId && typeof octokit.rest.checks.update === "function") {
    result = await octokit.rest.checks.update({
      owner: p.owner,
      repo: p.repo,
      check_run_id: checkRunId,
      name: SCAN_CHECK_NAME,
      head_sha: p.headSha,
      status: "completed",
      conclusion,
      output,
    });
  } else {
    result = await octokit.rest.checks.create({
      owner: p.owner,
      repo: p.repo,
      name: SCAN_CHECK_NAME,
      head_sha: p.headSha,
      status: "completed",
      conclusion,
      output,
    });

    checkRunId =
      (result as { data?: { id?: number }; id?: number } | undefined)?.data?.id ??
      (result as { id?: number } | undefined)?.id;
  }

  if (checkRunId && typeof octokit.rest.checks.update === "function") {
    for (let i = 1; i < batches.length; i++) {
      await octokit.rest.checks.update({
        owner: p.owner,
        repo: p.repo,
        check_run_id: checkRunId,
        output: {
          title: isZeroScan ? "Nothing to scan" : `Policy Decision: ${String(p.decision)}`,
          summary,
          annotations: batches[i],
        },
      });
    }
  }

  return result;
}

/** Fail-closed: a scan that crashed must not look like a pass. */
export async function postScanErrorCheckRun(
  octokit: ChecksClient,
  p: { owner: string; repo: string; headSha: string; reason: string; checkRunId?: number },
) {
  if (p.checkRunId && typeof octokit.rest.checks.update === "function") {
    return octokit.rest.checks.update({
      owner: p.owner,
      repo: p.repo,
      check_run_id: p.checkRunId,
      name: SCAN_CHECK_NAME,
      head_sha: p.headSha,
      status: "completed",
      conclusion: "failure",
      output: {
        title: "Scan could not complete",
        summary: `SecureFlow could not finish scanning this PR, so it cannot be treated as safe to merge.\n\nReason: ${p.reason}`,
      },
    });
  }

  return octokit.rest.checks.create({
    owner: p.owner,
    repo: p.repo,
    name: SCAN_CHECK_NAME,
    head_sha: p.headSha,
    status: "completed",
    conclusion: "failure",
    output: {
      title: "Scan could not complete",
      summary: `SecureFlow could not finish scanning this PR, so it cannot be treated as safe to merge.\n\nReason: ${p.reason}`,
    },
  });
}

/**
 * Marks a check run as neutral or cancelled when an in-flight scan is interrupted
 * by worker shutdown, reschedule, or termination (#1894).
 * Ensures pull requests are never left with a check run stuck in "in progress".
 */
export async function postScanCancelledCheckRun(
  octokit: ChecksClient,
  p: {
    owner: string;
    repo: string;
    headSha: string;
    reason?: string;
    checkRunId?: number;
    conclusion?: "neutral" | "cancelled";
  },
) {
  const conclusion = p.conclusion ?? "neutral";
  const reason =
    p.reason ??
    "The scan worker was terminated (e.g. during deployment, autoscaling, or node drain) before the scan could complete. The scan has been re-queued.";

  const output = {
    title: "Scan Interrupted",
    summary: `SecureFlow could not complete the scan because the worker container was stopped.\n\n${reason}`,
  };

  if (p.checkRunId && typeof octokit.rest.checks.update === "function") {
    return octokit.rest.checks.update({
      owner: p.owner,
      repo: p.repo,
      check_run_id: p.checkRunId,
      name: SCAN_CHECK_NAME,
      head_sha: p.headSha,
      status: "completed",
      conclusion,
      output,
    });
  }

  return octokit.rest.checks.create({
    owner: p.owner,
    repo: p.repo,
    name: SCAN_CHECK_NAME,
    head_sha: p.headSha,
    status: "completed",
    conclusion,
    output,
  });
}

/**
 * Posts or updates a neutral check run when a PR scan is skipped early (#1982).
 * e.g. for draft PRs or excluded bot authors configured in .secureflow.json.
 */
export async function postScanSkippedCheckRun(
  octokit: ChecksClient,
  p: {
    owner: string;
    repo: string;
    headSha: string;
    reason: string;
    checkRunId?: number;
  },
) {
  const output = {
    title: "SecureFlow — Scan Skipped",
    summary: p.reason,
  };

  if (p.checkRunId && typeof octokit.rest.checks.update === "function") {
    return octokit.rest.checks.update({
      owner: p.owner,
      repo: p.repo,
      check_run_id: p.checkRunId,
      name: SCAN_CHECK_NAME,
      head_sha: p.headSha,
      status: "completed",
      conclusion: "neutral",
      output,
    });
  }

  return octokit.rest.checks.create({
    owner: p.owner,
    repo: p.repo,
    name: SCAN_CHECK_NAME,
    head_sha: p.headSha,
    status: "completed",
    conclusion: "neutral",
    output,
  });
}
