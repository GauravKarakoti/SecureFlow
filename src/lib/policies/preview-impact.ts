/**
 * Policy Impact Preview Service (#1892)
 *
 * Replays recent stored scan inputs against a draft policy and the current policy.
 * Compares findings to determine which vulnerabilities would be newly detected,
 * which would disappear, and which remain unchanged, broken down by severity.
 *
 * Guarantees:
 * - Side-effect free: never writes findings, comments, or check runs.
 * - Resource bounded: caps replayed scans (default: 20) and total tokens (default: 50,000).
 * - Cache optimized: reuses cached results when diff and policy match.
 * - Graceful fallback: handles empty or limited scan history with clear messaging.
 */

import prisma from "@/lib/prisma";
import { redis } from "@/lib/redis";
import {
  scanner,
  type FileChange,
  type ScanFinding,
  type ScannerPolicy,
} from "@/lib/armor/scanner";
import {
  computeScanCacheHash,
  scanCacheKey,
  getCachedScan,
  setCachedScan,
} from "@/lib/scanner/scan-cache";
import { normalizeSeverity } from "@/lib/severity";
import {
  resolvePolicyConflicts,
  type PolicyResolutionResult,
  type ScopedPolicyRule,
} from "@/lib/policies/conflict-resolver";

export const DEFAULT_PREVIEW_MAX_SCANS = 20;
export const DEFAULT_PREVIEW_MAX_TOKENS = 50_000;

export const PREVIEW_SEVERITIES = ["CRITICAL", "HIGH", "MEDIUM", "LOW", "INFO"] as const;

export type PreviewSeverity = (typeof PREVIEW_SEVERITIES)[number];

export interface SeverityCountComparison {
  unchanged: number;
  newCount: number;
  removedCount: number;
  netChange: number;
}

export type SeverityComparisonMap = Record<PreviewSeverity | "TOTAL", SeverityCountComparison>;

export interface PreviewFindingItem {
  type: string;
  severity: string;
  description: string;
  fileLocation: string;
  lineStart?: number;
  lineEnd?: number;
  status: "NEW" | "REMOVED" | "UNCHANGED";
}

export interface PolicyPreviewImpactResult {
  ok: boolean;
  hasHistory: boolean;
  message?: string;
  error?: string;
  replayedScans: number;
  totalTokens: number;
  tokensBudgetExceeded?: boolean;
  severityComparison: SeverityComparisonMap;
  findings: {
    new: PreviewFindingItem[];
    removed: PreviewFindingItem[];
    unchanged: PreviewFindingItem[];
  };
  policy: {
    templateId: string;
    currentDescription: string;
    draftDescription: string;
    currentSeverity?: string;
    draftSeverity?: string;
  };
}

export interface PreviewPolicyImpactOptions {
  userId: string;
  templateId: string;
  draftDescription: string;
  draftSeverity?: string;
  maxScans?: number;
  maxTokens?: number;
  /** Dependency injection for tests */
  scannerFn?: (files: FileChange[], policies: ScannerPolicy[]) => Promise<ScanFinding[]>;
  db?: typeof prisma;
  redisClient?: typeof redis;
}

/**
 * Estimates LLM token count from unified patches (approx. 4 chars per token).
 */
export function estimateFilesTokens(files: FileChange[]): number {
  return files.reduce((sum, f) => {
    const patchLen = (f.patch || "").length;
    return sum + Math.max(1, Math.ceil(patchLen / 4));
  }, 0);
}

/**
 * Generates an empty severity comparison map with zeroes.
 */
export function createEmptySeverityComparison(): SeverityComparisonMap {
  return {
    CRITICAL: { unchanged: 0, newCount: 0, removedCount: 0, netChange: 0 },
    HIGH: { unchanged: 0, newCount: 0, removedCount: 0, netChange: 0 },
    MEDIUM: { unchanged: 0, newCount: 0, removedCount: 0, netChange: 0 },
    LOW: { unchanged: 0, newCount: 0, removedCount: 0, netChange: 0 },
    INFO: { unchanged: 0, newCount: 0, removedCount: 0, netChange: 0 },
    TOTAL: { unchanged: 0, newCount: 0, removedCount: 0, netChange: 0 },
  };
}

/**
 * Normalizes severity string to uppercase canonical severity key.
 */
function toPreviewSeverity(raw: unknown): PreviewSeverity {
  const norm = normalizeSeverity(raw);
  return norm as PreviewSeverity;
}

/**
 * Builds a deterministic identity key for a finding.
 */
function makeFindingKey(f: {
  fileLocation: string;
  lineStart?: number;
  type: string;
  description: string;
}): string {
  const loc = (f.fileLocation || "").trim().toLowerCase();
  const line = f.lineStart ?? 0;
  const t = (f.type || "").trim().toLowerCase();
  const desc = (f.description || "").trim().toLowerCase();
  return `${loc}:${line}:${t}:${desc}`;
}

/**
 * Runs scan with deduplication cache.
 */
async function runScanWithCache(
  files: FileChange[],
  policy: { description: string },
  scannerRunner: (files: FileChange[], policies: ScannerPolicy[]) => Promise<ScanFinding[]>,
  deps: { redisClient?: typeof redis; db?: typeof prisma },
): Promise<ScanFinding[]> {
  const hash = computeScanCacheHash({
    files,
    activePolicies: [policy],
  });
  const key = scanCacheKey(hash);

  const cached = await getCachedScan(key, deps);
  if (cached) {
    return cached;
  }

  const findings = await scannerRunner(files, [policy]);
  await setCachedScan(key, findings, undefined, deps).catch(() => {});
  return findings;
}

/**
 * Main impact preview engine:
 * Replays stored scan inputs against the draft and current policy versions.
 */
export async function previewPolicyImpact(
  options: PreviewPolicyImpactOptions,
): Promise<PolicyPreviewImpactResult> {
  const db = options.db ?? prisma;
  const redisClient = options.redisClient ?? redis;
  const scannerRunner =
    options.scannerFn ??
    ((files: FileChange[], policies: ScannerPolicy[]) =>
      scanner.scanPullRequest(files, policies, [], []));

  const maxScans = Math.max(
    1,
    options.maxScans ?? Number(process.env.POLICY_PREVIEW_MAX_SCANS || DEFAULT_PREVIEW_MAX_SCANS),
  );
  const maxTokens = Math.max(
    100,
    options.maxTokens ??
      Number(process.env.POLICY_PREVIEW_MAX_TOKENS || DEFAULT_PREVIEW_MAX_TOKENS),
  );

  const emptyComparison = createEmptySeverityComparison();

  // 1. Fetch current policy template
  const currentTemplate = await db.policyTemplate.findUnique({
    where: { id: options.templateId },
  });

  if (!currentTemplate) {
    return {
      ok: false,
      hasHistory: false,
      error: "Policy template not found",
      replayedScans: 0,
      totalTokens: 0,
      severityComparison: emptyComparison,
      findings: { new: [], removed: [], unchanged: [] },
      policy: {
        templateId: options.templateId,
        currentDescription: "",
        draftDescription: options.draftDescription,
      },
    };
  }

  const currentDesc = currentTemplate.description || "";
  const draftDesc = (options.draftDescription || "").trim();

  // 2. Locate all repositories belonging to the user
  const userRepos = await db.repository.findMany({
    where: { userId: options.userId },
    select: { id: true },
  });

  const repoIds = userRepos.map((r: { id: string }) => r.id);

  if (repoIds.length === 0) {
    return {
      ok: true,
      hasHistory: false,
      message:
        "No repositories found. Connect a repository and run scans before previewing policy changes.",
      replayedScans: 0,
      totalTokens: 0,
      severityComparison: emptyComparison,
      findings: { new: [], removed: [], unchanged: [] },
      policy: {
        templateId: options.templateId,
        currentDescription: currentDesc,
        draftDescription: draftDesc,
        currentSeverity: currentTemplate.severity,
        draftSeverity: options.draftSeverity || currentTemplate.severity,
      },
    };
  }

  // 3. Retrieve stored scan inputs for the user's repositories
  const candidateScans: Array<{ files: FileChange[]; tokenEstimate: number }> = [];

  // Try dedicated storedScanInput table first
  if (db.storedScanInput && typeof db.storedScanInput.findMany === "function") {
    try {
      const stored = await db.storedScanInput.findMany({
        where: { repositoryId: { in: repoIds } },
        orderBy: { createdAt: "desc" },
        take: maxScans,
      });

      for (const item of stored) {
        try {
          const parsed = JSON.parse(item.filesJson) as FileChange[];
          if (Array.isArray(parsed) && parsed.length > 0) {
            candidateScans.push({
              files: parsed,
              tokenEstimate: item.tokenEstimate || estimateFilesTokens(parsed),
            });
          }
        } catch {
          // ignore corrupted JSON record
        }
      }
    } catch (err) {
      console.warn("[PreviewImpact] storedScanInput query failed:", err);
    }
  }

  // Fallback: If no storedScanInput records exist, synthesize from stored findings in recent scans
  if (
    candidateScans.length === 0 &&
    db.scanResult &&
    typeof db.scanResult.findMany === "function"
  ) {
    try {
      const resultsWithFindings = await db.scanResult.findMany({
        where: {
          pullRequest: { repositoryId: { in: repoIds } },
          findings: { some: { codeSnippet: { not: null } } },
        },
        include: { findings: true },
        orderBy: { createdAt: "desc" },
        take: maxScans,
      });

      for (const res of resultsWithFindings) {
        const files: FileChange[] = (res.findings || [])
          .filter((f: any) => typeof f.codeSnippet === "string" && f.codeSnippet.trim())
          .map((f: any) => {
            const lines = f.codeSnippet.split("\n");
            const patch = `@@ -0,0 +1,${lines.length} @@\n${lines.map((l: string) => `+${l}`).join("\n")}`;
            return {
              filename: f.fileLocation || "snippet.ts",
              patch,
            };
          });

        if (files.length > 0) {
          candidateScans.push({
            files,
            tokenEstimate: estimateFilesTokens(files),
          });
        }
      }
    } catch (err) {
      console.warn("[PreviewImpact] scanResult fallback query failed:", err);
    }
  }

  // 4. Check if history exists
  if (candidateScans.length === 0) {
    return {
      ok: true,
      hasHistory: false,
      message:
        "Too little history exists for a meaningful preview. Run repository scans to generate historical scan data.",
      replayedScans: 0,
      totalTokens: 0,
      severityComparison: emptyComparison,
      findings: { new: [], removed: [], unchanged: [] },
      policy: {
        templateId: options.templateId,
        currentDescription: currentDesc,
        draftDescription: draftDesc,
        currentSeverity: currentTemplate.severity,
        draftSeverity: options.draftSeverity || currentTemplate.severity,
      },
    };
  }

  // 5. Replay scans with capping on N and total tokens
  let replayedScans = 0;
  let totalTokens = 0;
  let tokensBudgetExceeded = false;

  const allCurrentFindings: ScanFinding[] = [];
  const allDraftFindings: ScanFinding[] = [];

  const currentPolicy: ScannerPolicy = { description: currentDesc };
  const draftPolicy: ScannerPolicy = { description: draftDesc };

  for (const scan of candidateScans) {
    if (replayedScans >= maxScans) {
      break;
    }

    const estimated = scan.tokenEstimate || estimateFilesTokens(scan.files);
    if (totalTokens + estimated > maxTokens && replayedScans > 0) {
      tokensBudgetExceeded = true;
      break;
    }

    totalTokens += estimated;
    replayedScans++;

    try {
      const [curResults, draftResults] = await Promise.all([
        runScanWithCache(scan.files, currentPolicy, scannerRunner, {
          redisClient,
          db,
        }),
        runScanWithCache(scan.files, draftPolicy, scannerRunner, {
          redisClient,
          db,
        }),
      ]);

      allCurrentFindings.push(...curResults);
      allDraftFindings.push(...draftResults);
    } catch (err) {
      console.warn("[PreviewImpact] Failed replaying a scan:", err);
      // Continue with remaining scans
    }
  }

  // 6. Compare findings (New, Removed, Unchanged)
  const currentMap = new Map<string, ScanFinding>();
  for (const f of allCurrentFindings) {
    currentMap.set(makeFindingKey(f), f);
  }

  const draftMap = new Map<string, ScanFinding>();
  for (const f of allDraftFindings) {
    draftMap.set(makeFindingKey(f), f);
  }

  const newFindings: PreviewFindingItem[] = [];
  const removedFindings: PreviewFindingItem[] = [];
  const unchangedFindings: PreviewFindingItem[] = [];

  const severityComparison = createEmptySeverityComparison();

  // Find Unchanged and New findings from draftMap
  for (const [key, draftFinding] of draftMap.entries()) {
    const sev = toPreviewSeverity(draftFinding.severity);
    if (currentMap.has(key)) {
      unchangedFindings.push({
        type: draftFinding.type,
        severity: sev,
        description: draftFinding.description,
        fileLocation: draftFinding.fileLocation,
        lineStart: draftFinding.lineStart,
        lineEnd: draftFinding.lineEnd,
        status: "UNCHANGED",
      });
      severityComparison[sev].unchanged++;
      severityComparison.TOTAL.unchanged++;
    } else {
      newFindings.push({
        type: draftFinding.type,
        severity: sev,
        description: draftFinding.description,
        fileLocation: draftFinding.fileLocation,
        lineStart: draftFinding.lineStart,
        lineEnd: draftFinding.lineEnd,
        status: "NEW",
      });
      severityComparison[sev].newCount++;
      severityComparison.TOTAL.newCount++;
    }
  }

  // Find Removed findings (in currentMap but not in draftMap)
  for (const [key, curFinding] of currentMap.entries()) {
    if (!draftMap.has(key)) {
      const sev = toPreviewSeverity(curFinding.severity);
      removedFindings.push({
        type: curFinding.type,
        severity: sev,
        description: curFinding.description,
        fileLocation: curFinding.fileLocation,
        lineStart: curFinding.lineStart,
        lineEnd: curFinding.lineEnd,
        status: "REMOVED",
      });
      severityComparison[sev].removedCount++;
      severityComparison.TOTAL.removedCount++;
    }
  }

  // Calculate netChange for each severity and total
  for (const sev of PREVIEW_SEVERITIES) {
    severityComparison[sev].netChange =
      severityComparison[sev].newCount - severityComparison[sev].removedCount;
  }
  severityComparison.TOTAL.netChange =
    severityComparison.TOTAL.newCount - severityComparison.TOTAL.removedCount;

  return {
    ok: true,
    hasHistory: true,
    replayedScans,
    totalTokens,
    tokensBudgetExceeded,
    severityComparison,
    findings: {
      new: newFindings,
      removed: removedFindings,
      unchanged: unchangedFindings,
    },
    policy: {
      templateId: options.templateId,
      currentDescription: currentDesc,
      draftDescription: draftDesc,
      currentSeverity: currentTemplate.severity,
      draftSeverity: options.draftSeverity || currentTemplate.severity,
    },
  };
}

/**
 * Dry-run policy conflict simulation across ORG, REPO, and BRANCH rules.
 */
export function simulatePolicyConflicts(rules: ScopedPolicyRule[]): PolicyResolutionResult {
  return resolvePolicyConflicts(rules);
}
