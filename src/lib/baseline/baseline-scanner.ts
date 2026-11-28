/**
 * Baseline Scanner Engine & Scheduled Job Dispatcher (#2011)
 *
 * Scans the default branch of repositories in chunks, respecting time budgets,
 * default ignores, and fair scheduling across installations. Discovered issues
 * are stored tagged as BASELINE, allowing teams to review pre-existing debt
 * in a dedicated dashboard view without blocking pull requests.
 */

import prisma from "@/lib/prisma";
import { scanner, type ScanFinding, type FileChange } from "@/lib/armor/scanner";
import { computeFingerprint } from "@/lib/armor/fingerprint";
import {
  compileIgnorePatterns,
  ignoreReasonFor,
  resolveDefaultSkippedFiles,
} from "@/lib/armor/ignore-rules";
import { runDeterministicPrecheck } from "@/lib/armor/precheck";
import { runWorkflowSecurityRules } from "@/lib/rules/workflow-rules";
import { runDependencySecurityRules } from "@/lib/rules/dependency-rules";
import { fairQueueScheduler, type FairJob } from "@/lib/queue/fair-scheduler";
import { scanResultCreateData, type EnrichedScanFinding } from "@/lib/scanner/scan-persistence";
import {
  evaluateBaselineDiff,
  type BaselineDiffResult,
  type BaselineFindingLike,
  type BaselineGatePolicy,
} from "@/lib/baseline/baseline-diff";

export const DEFAULT_BASELINE_FILE_LIMIT = 50;
export const MIN_BASELINE_FILE_LIMIT = 1;
export const MAX_BASELINE_FILE_LIMIT = 200;
export const BASELINE_PR_NUMBER = 0;
export const BASELINE_TAG = "BASELINE";

export type BaselineFrequency = "daily" | "weekly" | "monthly";

export const BASELINE_INTERVALS_MS: Record<BaselineFrequency, number> = {
  daily: 24 * 60 * 60 * 1000,
  weekly: 7 * 24 * 60 * 60 * 1000,
  monthly: 30 * 24 * 60 * 60 * 1000,
};

/**
 * Bounds the baseline file scan count to safe limits.
 */
export function clampBaselineFileLimit(
  limit: number | string | null | undefined,
  fallback = DEFAULT_BASELINE_FILE_LIMIT,
): number {
  if (limit === null || limit === undefined) return fallback;
  const parsed = typeof limit === "number" ? limit : parseInt(String(limit), 10);
  if (isNaN(parsed) || !isFinite(parsed)) return fallback;
  return Math.min(MAX_BASELINE_FILE_LIMIT, Math.max(MIN_BASELINE_FILE_LIMIT, Math.floor(parsed)));
}

/**
 * Checks if a scheduled baseline scan is due for a repository.
 */
export function isBaselineScanDue(
  repo: {
    baselineScanEnabled: boolean;
    baselineFrequency?: string | null;
    lastBaselineScanAt?: Date | string | null;
  },
  now: Date = new Date(),
): boolean {
  if (!repo.baselineScanEnabled) {
    return false;
  }

  if (!repo.lastBaselineScanAt) {
    return true; // Never scanned before
  }

  const lastScanTime =
    repo.lastBaselineScanAt instanceof Date
      ? repo.lastBaselineScanAt.getTime()
      : new Date(repo.lastBaselineScanAt).getTime();

  if (isNaN(lastScanTime)) {
    return true;
  }

  const freq = (repo.baselineFrequency?.toLowerCase() ?? "weekly") as BaselineFrequency;
  const intervalMs = BASELINE_INTERVALS_MS[freq] ?? BASELINE_INTERVALS_MS.weekly;

  return now.getTime() - lastScanTime >= intervalMs;
}

/**
 * Validates whether a baseline scan is permitted to run.
 */
export function canRunBaselineScan(
  repo: {
    baselineScanEnabled: boolean;
    baselineFrequency?: string | null;
    lastBaselineScanAt?: Date | string | null;
  },
  options: { force?: boolean; now?: Date } = {},
): { allowed: boolean; reason?: string } {
  if (!repo.baselineScanEnabled && !options.force) {
    return {
      allowed: false,
      reason: "Baseline scans are disabled for this repository.",
    };
  }

  if (options.force) {
    return { allowed: true };
  }

  if (!isBaselineScanDue(repo, options.now)) {
    return {
      allowed: false,
      reason: `Baseline scan is not due yet for repository frequency (${repo.baselineFrequency ?? "weekly"}).`,
    };
  }

  return { allowed: true };
}

export interface BaselineFileItem {
  filename: string;
  content: string;
}

export interface BaselineScanExecutionOptions {
  repositoryId: string;
  repositoryFullName: string;
  installationId?: number | string;
  defaultBranch?: string;
  fileLimit?: number;
  files?: BaselineFileItem[];
  client?: any; // Octokit client
  db?: any; // Prisma client
  force?: boolean;
  timeBudgetMs?: number;
  customIgnores?: string[];
  customPlaceholders?: string[];
  activePolicies?: Array<{ description: string; [key: string]: unknown }>;
}

export interface BaselineScanResult {
  scanResultId: string;
  scannedFiles: number;
  findingsFound: number;
  policyDecision: string;
  riskScore: number;
  findings: EnrichedScanFinding[];
}

/**
 * Fetches default branch files via Octokit git tree API, bounded by limit and ignore filters.
 */
export async function fetchDefaultBranchFiles(
  client: any,
  options: {
    owner: string;
    repo: string;
    defaultBranch: string;
    fileLimit: number;
    customIgnores?: string[];
  },
): Promise<BaselineFileItem[]> {
  const { owner, repo, defaultBranch, fileLimit, customIgnores = [] } = options;

  if (!client) {
    return [];
  }

  try {
    // 1. Fetch git tree recursively
    const treeRes = await client.rest.git.getTree({
      owner,
      repo,
      tree_sha: defaultBranch,
      recursive: "true",
    });

    const tree = treeRes?.data?.tree || [];
    const compiledIgnores = compileIgnorePatterns(customIgnores);

    // 2. Filter candidate blobs
    const candidateFiles = tree
      .filter((node: any) => {
        if (node.type !== "blob" || typeof node.path !== "string") return false;
        if (ignoreReasonFor(node.path, compiledIgnores)) return false;
        return true;
      })
      .slice(0, clampBaselineFileLimit(fileLimit));

    // 3. Retrieve content for each file
    const results: BaselineFileItem[] = [];
    for (const item of candidateFiles) {
      try {
        const contentRes = await client.rest.repos.getContent({
          owner,
          repo,
          path: item.path,
          ref: defaultBranch,
        });

        const data = contentRes?.data;
        if (data && typeof data.content === "string") {
          const encoding = data.encoding === "base64" ? "base64" : "utf-8";
          const text = Buffer.from(data.content, encoding).toString("utf-8");
          results.push({ filename: item.path, content: text });
        }
      } catch {
        // Continue fetching remaining files on individual blob fetch error
      }
    }

    return results;
  } catch (err) {
    console.warn(`[BaselineScanner] Failed to fetch git tree for ${owner}/${repo}:`, err);
    return [];
  }
}

/**
 * Executes a baseline scan on the repository's default branch.
 * Chunks files, enriches findings, tags them as BASELINE, and saves them
 * under a synthetic baseline PR record (prNumber: 0) without triggering PR comments.
 */
export async function executeBaselineScan(
  options: BaselineScanExecutionOptions,
): Promise<BaselineScanResult> {
  const db = options.db ?? prisma;
  const { repositoryId, repositoryFullName, defaultBranch = "main" } = options;

  // 1. Check repository configuration and eligibility
  const repo = await db.repository.findUnique({
    where: { id: repositoryId },
  });

  if (!repo) {
    throw new Error(`Repository not found: ${repositoryId}`);
  }

  const eligibility = canRunBaselineScan(repo, { force: options.force });
  if (!eligibility.allowed) {
    throw new Error(eligibility.reason || "Baseline scan is not allowed at this time.");
  }

  const fileLimit = clampBaselineFileLimit(options.fileLimit ?? repo.baselineFileLimit);

  // 2. Resolve files to scan
  let filesToScan: BaselineFileItem[] = options.files ?? [];
  if (filesToScan.length === 0 && options.client) {
    const [owner, repoName] = repositoryFullName.split("/");
    filesToScan = await fetchDefaultBranchFiles(options.client, {
      owner,
      repo: repoName,
      defaultBranch,
      fileLimit,
      customIgnores: options.customIgnores,
    });
  }

  filesToScan = filesToScan.slice(0, fileLimit);

  // Convert files into FileChange structures formatted as whole-file additions
  const fileChanges: FileChange[] = filesToScan.map((f) => ({
    filename: f.filename,
    patch: `@@ -0,0 +1,${f.content.split("\n").length} @@\n${f.content
      .split("\n")
      .map((line) => `+${line}`)
      .join("\n")}`,
  }));

  // 3. Scan files using deterministic rules and LLM/signature scanner
  const allFindings: EnrichedScanFinding[] = [];

  // Deterministic checks (secrets, workflow rules, dependency rules)
  const precheckFindings = runDeterministicPrecheck(fileChanges, {
    customIgnores: options.customIgnores ?? [],
    customPlaceholders: options.customPlaceholders ?? [],
  });
  allFindings.push(...(precheckFindings as EnrichedScanFinding[]));

  const workflowFindings = runWorkflowSecurityRules(fileChanges);
  allFindings.push(...(workflowFindings as EnrichedScanFinding[]));

  const dependencyFindings = runDependencySecurityRules(fileChanges);
  allFindings.push(...(dependencyFindings as EnrichedScanFinding[]));

  // Scanner chunked processing
  if (fileChanges.length > 0) {
    try {
      const scannerFindings = await scanner.scanPullRequest(
        fileChanges,
        (options.activePolicies ?? []) as any[],
        options.customIgnores ?? [],
        options.customPlaceholders ?? [],
        repositoryId,
        undefined,
        { timeoutBudgetMs: options.timeBudgetMs ?? 60_000 },
      );
      allFindings.push(...(scannerFindings as EnrichedScanFinding[]));
    } catch (scanErr) {
      console.warn("[BaselineScanner] Partial scanner timeout/error:", scanErr);
    }
  }

  // 4. Enrich and tag all findings as BASELINE
  const taggedFindings: EnrichedScanFinding[] = allFindings.map((finding) => {
    const fp =
      finding.fingerprint ||
      computeFingerprint(repo.id, finding.fileLocation, finding.type, finding.codeSnippet);
    return {
      ...finding,
      fingerprint: fp,
      tag: BASELINE_TAG,
      isBaseline: true,
      complianceTags: [BASELINE_TAG, ...(finding.matchedSignatures ?? [])],
    };
  });

  // 5. Ensure baseline PR container exists (prNumber: 0)
  const syntheticGithubId = BigInt(repo.githubId) * BigInt(1_000_000);
  const baselinePr = await db.pullRequest.upsert({
    where: {
      repositoryId_prNumber: {
        repositoryId: repo.id,
        prNumber: BASELINE_PR_NUMBER,
      },
    },
    update: {
      title: `Baseline Scan (${defaultBranch})`,
      authorLogin: "secureflow[bot]",
      state: "OPEN",
    },
    create: {
      githubId: syntheticGithubId,
      prNumber: BASELINE_PR_NUMBER,
      title: `Baseline Scan (${defaultBranch})`,
      state: "OPEN",
      status: "REVIEW_REQUIRED",
      authorLogin: "secureflow[bot]",
      repositoryId: repo.id,
    },
  });

  // 6. Save ScanResult with scanType: "BASELINE"
  const scanResultData = scanResultCreateData({
    pullRequestId: baselinePr.id,
    headSha: defaultBranch,
    decision: taggedFindings.length > 0 ? "REVIEW" : "PASS",
    scoredFindings: taggedFindings,
    findingsToPersist: taggedFindings,
    scanType: BASELINE_TAG,
  });

  const scanResult = await db.scanResult.create({
    data: scanResultData,
    include: {
      findings: true,
    },
  });

  // 7. Update repository baseline scan timestamp and status
  await db.repository.update({
    where: { id: repositoryId },
    data: {
      lastBaselineScanAt: new Date(),
      lastBaselineScanStatus: "COMPLETED",
    },
  });

  return {
    scanResultId: scanResult.id,
    scannedFiles: fileChanges.length,
    findingsFound: taggedFindings.length,
    policyDecision: scanResult.policyDecision,
    riskScore: scanResult.riskScore,
    findings: taggedFindings,
  };
}

/**
 * Enqueues a baseline scan in the fair scheduler to respect installation concurrency.
 */
export function scheduleBaselineScanJob(jobData: BaselineScanExecutionOptions): boolean {
  const jobId = `baseline:${jobData.repositoryId}:${Date.now()}`;
  const instId = jobData.installationId || "default";

  const fairJob: FairJob<BaselineScanExecutionOptions> = {
    id: jobId,
    installationId: instId,
    repositoryFullName: jobData.repositoryFullName,
    prNumber: BASELINE_PR_NUMBER,
    data: jobData,
  };

  return fairQueueScheduler.enqueue(fairJob);
}

/**
 * Evaluates current PR findings against stored baseline findings using regression gate rules.
 */
export function evaluatePullRequestAgainstBaseline<
  T extends BaselineFindingLike = BaselineFindingLike,
>(baselineFindings: T[], currentFindings: T[], policy?: BaselineGatePolicy): BaselineDiffResult<T> {
  return evaluateBaselineDiff(baselineFindings, currentFindings, policy);
}
