/**
 * Scan Engine — Processes scan jobs with chunked file processing and progress reporting.
 *
 * Refactors the synchronous scanPullRequest flow into an async, queue-compatible
 * pipeline that reports progress as files are scanned.
 *
 * Usage (from worker):
 *    import { processScanJob } from '@/lib/scanner/scanEngine';
 *    const result = await processScanJob(jobData, onProgress);
 */

import { scanner, ScannerTimeoutError } from "@/lib/armor/scanner";
import { estimateDiffTokens } from "@/lib/armor/diff";
import { iq } from "@/lib/armor/iq";
import { computeFingerprint } from "@/lib/armor/fingerprint";
import { developerReceivesAISecurityExplanations } from "@/ai/flows/developer-receives-ai-security-explanations";
import { maskFindingText } from "@/lib/armor/secret-masking";
import prisma from "@/lib/prisma";
import { sanitizeAuditLogInput } from "@/lib/audit/minimization";
import { severityBadge } from "@/lib/severity";
import {
  upsertSecureFlowComment,
  SECUREFLOW_COMMENT_MARKER,
  formatScanMetadata,
} from "@/lib/github/sticky-comment";
import { App } from "octokit";
import { logger } from "@/lib/logger";
import { postScanCheckRun } from "./check-run";
import { getZeroScanReason, type ZeroScanReason } from "./zero-scan";
import {
  compileIgnorePatterns,
  ignoreReasonFor,
  resolveDefaultSkippedFiles,
} from "@/lib/armor/ignore-rules";
import { runDeterministicPrecheck } from "@/lib/armor/precheck";
import { runDependencySecurityRules } from "@/lib/rules/dependency-rules";
import { runWorkflowSecurityRules } from "@/lib/rules/workflow-rules";
import { runIacSecurityRules } from "@/lib/rules/iac-rules";
import { runPatternSecurityRules } from "@/lib/rules/pattern-rules";
import { runUnicodeSecurityRules } from "@/lib/rules/unicode-rules";
import { runObfuscationSecurityRules } from "@/lib/rules/obfuscation-rules";
import { runOutboundSecurityRules } from "@/lib/rules/outbound-rules";
import { runSensitiveFileRules } from "@/lib/rules/sensitive-file-rules";
import {
  resolveIacRuleOptions,
  resolvePatternRuleOptions,
  resolveUnicodeRuleOptions,
} from "./gate-config";
// From the side-effect-free helper, not `@/lib/queue/worker`: that module
// constructs the webhook BullMQ Worker when it is imported, so importing the
// credentials from it started a queue consumer in whatever process loaded this.
import { getGitHubAppCredentials } from "@/lib/github/app-auth";
import { fetchPullRequestFiles } from "@/lib/github/pull-request-files";
import type { ScanJobData } from "@/lib/queue/scanQueue";
import { updateScanJobProgress } from "@/lib/queue/scanQueue";
import {
  parseInstallationId,
  progressPercent,
  scanResultCreateData,
  ScanPersistenceError,
  storedPolicyDecision,
  storedRiskScore,
  type EnrichedScanFinding,
} from "./scan-persistence";
import { resolvePullRequestRecord, splitRepositoryFullName } from "./pull-request-record";
import {
  loadTrustedIgnoreConfig,
  type IgnoreConfigClient,
  type SecureFlowIgnoreConfig,
  type ExpiredIgnoreRule,
} from "./ignore-config";
import {
  loadTrustedGateConfig,
  formatGateSummaryLine,
  DEFAULT_GATE_CONFIG,
  type GateConfig,
  resolveScanTimeoutBudgetMs,
  resolveScanRequestTimeoutMs,
  resolveVerifyCritical,
  resolveContextLines,
  resolveSuggestionsConfig,
} from "./gate-config";
import { buildEffectiveGateConfig } from "./installation-settings";
import { verifyCriticalFindings } from "./critical-verification";
import { commentableLineNumbers, parseUnifiedPatch } from "@/lib/armor/diff";
import {
  buildInlineReviewComments,
  postSuggestedChangesReview,
} from "@/lib/github/suggested-changes";
import { evaluateSuppressionRules } from "@/lib/suppression-rules/matcher";
import {
  getActiveSuppressionRules,
  recordSuppressionRuleEvents,
} from "@/lib/suppression-rules/service";
import {
  groupFilesByPolicyScope,
  collectAppliedScopes,
  formatAppliedScopesSection,
  type AppliedScopeSummary,
} from "./policy-scopes";
import { notifyHighSeverityFindings } from "@/lib/integrations/slack";
import { notifyBlockedScan } from "@/lib/integrations/notification-dispatcher";
import { dispatchCriticalChatAlert } from "@/lib/integrations/chat-webhook";
import { activeSuppressionWhere, handleExpiredDismissals } from "../triage/expiry-server";
import { computeScanCacheHash, getCachedScan, scanCacheKey, setCachedScan } from "./scan-cache";
import { getPolicyVersion } from "@/lib/policies/policy-cache";
import { autoResolveFixedFindings } from "@/lib/findings/auto-resolve";
import { isConfidenceAtLeast } from "@/lib/confidence";

/** Maximum files to process in a single batch before yielding. */
const CHUNK_SIZE = 10;

/** Delay between chunks to avoid overwhelming the LLM API. */
const CHUNK_DELAY_MS = 100;

/**
 * Maximum number of findings enriched with AI explanations concurrently.
 *
 * Previously all findings were enriched with Promise.all, firing every AI call
 * at once. On a PR with many findings this immediately exhausted the Groq rate
 * limit (429) and caused all retries to fire simultaneously — a thundering herd.
 * Processing in batches of this size keeps the request rate within limits.
 */
const AI_ENRICHMENT_CONCURRENCY = 3;

export interface ScanJobResult {
  scanJobId: string;
  scannedFiles: number;
  vulnerabilitiesFound: number;
  riskScore: number;
  policyDecision: "PASS" | "REVIEW" | "BLOCK";
  verdict: string;
  findings: EnrichedScanFinding[];
  skippedFiles?: Array<{ filename: string; reason: string }>;
  reusedFromCache?: boolean;
  expiredIgnoreRules?: ExpiredIgnoreRule[];
  appliedPolicyScopes?: AppliedScopeSummary[];
  analyzedFiles?: string[];
  zeroScanReason?: ZeroScanReason;
  defaultSkippedCount?: number;
  isPartial?: boolean;
  timedOut?: boolean;
}

export interface ScanProgress {
  phase: "starting" | "scanning" | "enriching" | "posting" | "completed";
  scannedFiles: number;
  totalFiles: number;
  vulnerabilitiesFound: number;
  progress: number;
}

type ProgressCallback = (progress: ScanProgress) => void;

export class ScanIncompleteError extends Error {
  constructor(
    readonly failedFiles: readonly string[],
    readonly cause: unknown,
  ) {
    const reason = cause instanceof Error ? cause.message : String(cause);
    super(`Scan incomplete: ${failedFiles.length} file(s) could not be analysed (${reason})`);
    this.name = "ScanIncompleteError";
  }
}

export interface ProcessScanJobOptions {
  report?: boolean;
  persist?: boolean;
  enrich?: boolean;
}

export async function processScanJob(
  data: ScanJobData,
  onProgress: ProgressCallback = () => {},
  options: ProcessScanJobOptions = {},
): Promise<ScanJobResult> {
  const { report = true, persist = true, enrich = true } = options;
  const {
    scanJobId,
    repositoryId,
    installationId,
    repositoryFullName,
    prNumber,
    headSha,
    baseRef,
    fileChanges: initialFileChanges,
    activePolicies,
    customIgnores: initialCustomIgnores,
    customPlaceholders: initialCustomPlaceholders,
    userId,
  } = data;

  const correlationId = data.correlationId || data.scanJobId;
  const log = logger.child({ correlationId, scanJobId: data.scanJobId });

  log.info(`[ScanEngine] Starting scan for ${repositoryFullName}#${prNumber}`);
  console.log(`[ScanEngine] Starting scan for ${repositoryFullName}#${prNumber}`);

  onProgress({
    phase: "starting",
    scannedFiles: 0,
    totalFiles: initialFileChanges.length,
    vulnerabilitiesFound: 0,
    progress: 0,
  });

  const { appId, privateKey, Octokit: customOctokit } = getGitHubAppCredentials();
  const appClient = new App({
    appId,
    privateKey,
    ...(customOctokit ? { Octokit: customOctokit } : {}),
  });
  const octokit = await appClient.getInstallationOctokit(parseInstallationId(installationId));

  let repositoryGateConfig: GateConfig = { ...DEFAULT_GATE_CONFIG };
  let repositoryIgnoreConfig: SecureFlowIgnoreConfig = {
    ignoredPaths: [],
    placeholders: [],
    rules: [],
    expiredRules: [],
    warnings: [],
  };
  try {
    const { owner, repo } = splitRepositoryFullName(repositoryFullName);
    const client = octokit as unknown as IgnoreConfigClient;
    repositoryIgnoreConfig = await loadTrustedIgnoreConfig(client, {
      owner,
      repo,
      prNumber,
      baseRef,
    });
    repositoryGateConfig = await loadTrustedGateConfig(client, {
      owner,
      repo,
      prNumber,
      baseRef,
    });
  } catch (err) {
    log.warn(`[ScanEngine] Could not load ignore configuration for ${repositoryFullName}:`, {
      error: err instanceof Error ? err.message : String(err),
    });
    console.warn(
      `[ScanEngine] Could not load ignore configuration for ${repositoryFullName}:`,
      err,
    );
  }

  // Hierarchical settings resolution: Built-in -> Installation -> Repository (.secureflow.json) (#2010)
  try {
    const instId = String(installationId || "default");
    const instRecord =
      (await (prisma as any).installationSettings?.findUnique?.({
        where: { installationId: instId },
      })) ||
      (instId !== "default"
        ? await (prisma as any).installationSettings?.findUnique?.({
            where: { installationId: "default" },
          })
        : null);

    if (instRecord) {
      repositoryGateConfig = buildEffectiveGateConfig(repositoryGateConfig, {
        installationId: instRecord.installationId,
        gateBlockOn: instRecord.gateBlockOn,
        gateReviewOn: instRecord.gateReviewOn,
        minCommentConfidence: instRecord.minCommentConfidence,
        includeDefaults: instRecord.includeDefaults,
        skipDrafts: instRecord.skipDrafts,
        skipAuthors: instRecord.skipAuthors,
        lockedSettings: instRecord.lockedSettings,
      });
    } else {
      repositoryGateConfig = buildEffectiveGateConfig(repositoryGateConfig, null);
    }
  } catch (err) {
    log.warn(`[ScanEngine] Could not load installation settings for ${repositoryFullName}:`, {
      error: err instanceof Error ? err.message : String(err),
    });
  }

  if (repositoryIgnoreConfig.warnings && repositoryIgnoreConfig.warnings.length > 0) {
    for (const warning of repositoryIgnoreConfig.warnings) {
      log.warn(`[ScanEngine] ${warning}`);
    }
  }

  const customIgnores = [...(initialCustomIgnores ?? []), ...repositoryIgnoreConfig.ignoredPaths];
  const customPlaceholders = [
    ...(initialCustomPlaceholders ?? []),
    ...repositoryIgnoreConfig.placeholders,
  ];
  const compiledCustomIgnores = compileIgnorePatterns(customIgnores);

  let fileChanges = initialFileChanges;
  const fetchedUnscannedFiles: Array<{ filename: string; reason: string }> = [];
  if (
    (!fileChanges || fileChanges.length === 0) &&
    typeof (octokit as any)?.paginate?.iterator === "function"
  ) {
    const { owner, repo } = splitRepositoryFullName(repositoryFullName);
    const result = await fetchPullRequestFiles(octokit as any, {
      owner,
      repo,
      pullNumber: prNumber,
    });
    fileChanges = result.files
      .filter((f: any) => f.patch && f.status !== "removed")
      .map((f: any) => ({ filename: f.filename, patch: f.patch }));
    if (result.unscannedFiles && result.unscannedFiles.length > 0) {
      fetchedUnscannedFiles.push(...result.unscannedFiles);
    }
  }
  fileChanges = fileChanges ?? [];

  const totalFiles = fileChanges.length;
  log.info(`[ScanEngine] Scanning ${totalFiles} files`);
  console.log(`[ScanEngine] Scanning ${totalFiles} files`);

  let policyVersion = "1.0.0";
  if (userId) {
    try {
      policyVersion = await getPolicyVersion(userId);
    } catch {
      policyVersion = "1.0.0";
    }
  }

  const cacheHash = computeScanCacheHash({
    files: fileChanges,
    activePolicies: (activePolicies as any[]) || [],
    policyVersion,
    customIgnores,
    customPlaceholders,
    policyScopes: repositoryGateConfig.policyScopes,
  });
  const cacheKey = scanCacheKey(cacheHash);

  let reusedFromCache = false;
  let allFindings: EnrichedScanFinding[] = [];
  let allAnalyzedFiles: string[] = [];
  const allSkippedFiles: Array<{ filename: string; reason: string }> = [
    ...(data.skippedFiles ?? []),
    ...fetchedUnscannedFiles,
  ];
  let budgetExceeded = false;

  const ignoreOptions = {
    includeDefaults: repositoryGateConfig.includeDefaults,
    forceInclude: repositoryGateConfig.forceInclude,
  };

  const precheckFindings = runDeterministicPrecheck(fileChanges, {
    customPlaceholders,
    customIgnores,
    repositoryId,
  });
  const precheckFilesWithSecrets = new Set(precheckFindings.map((f) => f.fileLocation));

  const {
    skippedByDefault,
    skippedCount: defaultSkippedCount,
    exemptSecretFiles,
  } = resolveDefaultSkippedFiles(fileChanges, customIgnores, {
    includeDefaults: repositoryGateConfig.includeDefaults,
    forceInclude: repositoryGateConfig.forceInclude,
    hasDeterministicSecrets: (file) => precheckFilesWithSecrets.has(file.filename),
  });

  const appliedPolicyScopes = collectAppliedScopes(fileChanges, repositoryGateConfig.policyScopes);

  const cachedFindings = await getCachedScan(cacheKey);
  if (cachedFindings) {
    reusedFromCache = true;
    allFindings = cachedFindings.map((f) => ({ ...f }));
    allAnalyzedFiles = fileChanges.map((f) => f.filename);
    log.info(
      `[ScanEngine] Reusing ${allFindings.length} scan findings from cache for ${repositoryFullName}#${prNumber}`,
    );
    console.log(
      `[ScanEngine] Reusing ${allFindings.length} scan findings from cache for ${repositoryFullName}#${prNumber}`,
    );

    onProgress({
      phase: "scanning",
      scannedFiles: totalFiles,
      totalFiles,
      vulnerabilitiesFound: allFindings.length,
      progress: 80,
    });
  } else {
    onProgress({
      phase: "scanning",
      scannedFiles: 0,
      totalFiles,
      vulnerabilitiesFound: 0,
      progress: 0,
    });

    let scannedFiles = 0;
    const timeoutBudgetMs = resolveScanTimeoutBudgetMs(repositoryGateConfig);
    const requestTimeoutMs = resolveScanRequestTimeoutMs(repositoryGateConfig);
    const scanStartedAt = Date.now();
    budgetExceeded = false;

    const fileGroups = groupFilesByPolicyScope(
      fileChanges,
      activePolicies as any[],
      repositoryGateConfig.policyScopes,
    );

    for (const group of fileGroups) {
      for (let i = 0; i < group.files.length; i += CHUNK_SIZE) {
        const chunk = group.files.slice(i, i + CHUNK_SIZE);

        if (budgetExceeded || Date.now() - scanStartedAt >= timeoutBudgetMs) {
          budgetExceeded = true;
          for (const f of chunk) {
            allSkippedFiles.push({
              filename: f.filename,
              reason: `Scan time budget of ${Math.round(timeoutBudgetMs / 1000)}s exceeded`,
            });
          }
          continue;
        }

        try {
          const hasCustomIgnoreOptions =
            repositoryGateConfig.includeDefaults !== undefined ||
            (repositoryGateConfig.forceInclude && repositoryGateConfig.forceInclude.length > 0);

          const hasCustomTimeouts =
            repositoryGateConfig.timeoutBudget !== undefined ||
            repositoryGateConfig.timeoutBudgetSeconds !== undefined ||
            repositoryGateConfig.requestTimeout !== undefined ||
            repositoryGateConfig.requestTimeoutSeconds !== undefined ||
            repositoryGateConfig.contextLines !== undefined;

          const remainingBudgetMs = Math.max(0, timeoutBudgetMs - (Date.now() - scanStartedAt));
          const timeoutOptions = {
            timeoutBudgetMs: remainingBudgetMs,
            requestTimeoutMs,
            contextLines: repositoryGateConfig.contextLines,
          };

          const chunkFindings =
            hasCustomIgnoreOptions || hasCustomTimeouts
              ? await scanner.scanPullRequest(
                  chunk,
                  group.policies as any[],
                  customIgnores,
                  customPlaceholders,
                  repositoryId || "default-repo",
                  ignoreOptions,
                  timeoutOptions,
                )
              : await scanner.scanPullRequest(
                  chunk,
                  group.policies as any[],
                  customIgnores,
                  customPlaceholders,
                );
          allFindings.push(...chunkFindings);
          if (scanner.lastSkippedFiles && scanner.lastSkippedFiles.length > 0) {
            allSkippedFiles.push(...scanner.lastSkippedFiles);
          }
          if (scanner.lastAnalyzedFiles && scanner.lastAnalyzedFiles.length > 0) {
            allAnalyzedFiles.push(...scanner.lastAnalyzedFiles);
          } else if (scanner.lastAnalyzedFiles === undefined) {
            const scannableChunkFiles = chunk
              .filter(
                (f) =>
                  !skippedByDefault.has(f.filename) &&
                  (exemptSecretFiles.has(f.filename) ||
                    ignoreReasonFor(f.filename, compiledCustomIgnores, ignoreOptions) === null),
              )
              .map((f) => f.filename);
            allAnalyzedFiles.push(...scannableChunkFiles);
          }
        } catch (err) {
          const isTimeout =
            err instanceof ScannerTimeoutError ||
            (err instanceof Error &&
              (err.name === "ScannerTimeoutError" ||
                /timed out|timeout|deadline/i.test(err.message))) ||
            Date.now() - scanStartedAt >= timeoutBudgetMs;

          if (isTimeout) {
            budgetExceeded = true;
            log.warn(
              `[ScanEngine] Scan timeout budget exceeded for chunk ${i}-${i + chunk.length}:`,
              {
                error: err instanceof Error ? err.message : String(err),
              },
            );
            console.warn(
              `[ScanEngine] Scan timeout budget exceeded for chunk ${i}-${i + chunk.length}:`,
              err,
            );
            for (const f of chunk) {
              allSkippedFiles.push({
                filename: f.filename,
                reason: `Scan timeout budget of ${Math.round(timeoutBudgetMs / 1000)}s exceeded`,
              });
            }
            continue;
          }

          log.error(`[ScanEngine] Error scanning chunk ${i}-${i + chunk.length}:`, {
            error: err instanceof Error ? err.message : String(err),
          });
          console.error(`[ScanEngine] Error scanning chunk ${i}-${i + chunk.length}:`, err);
          throw new ScanIncompleteError(
            chunk.map((file) => file.filename),
            err,
          );
        }

        scannedFiles += chunk.length;
        const vulnCount = allFindings.length;
        const progress = progressPercent(scannedFiles, totalFiles);

        onProgress({
          phase: "scanning",
          scannedFiles,
          totalFiles,
          vulnerabilitiesFound: vulnCount,
          progress,
        });

        await updateScanJobProgress(scanJobId, {
          scannedFiles,
          vulnerabilitiesFound: vulnCount,
        }).catch(() => {});

        if (scannedFiles < totalFiles) {
          await new Promise((resolve) => setTimeout(resolve, CHUNK_DELAY_MS));
        }
      }
    }

    await setCachedScan(cacheKey, allFindings).catch((err) => {
      console.warn("[ScanEngine] Failed to save findings to scan cache:", err);
    });
  }

  // Ensure deterministic dependency security checks are present (#2003)
  const dependencyRuleFindings = runDependencySecurityRules(fileChanges, { repositoryId });
  for (const df of dependencyRuleFindings) {
    const alreadyExists = allFindings.some(
      (f) =>
        f.fileLocation === df.fileLocation &&
        f.lineStart === df.lineStart &&
        f.matchedSignatures?.some((s) => df.matchedSignatures?.includes(s)),
    );
    if (!alreadyExists) {
      allFindings.push(df);
    }
  }

  // Ensure deterministic workflow security rules are present (#2002)
  const workflowRuleFindings = runWorkflowSecurityRules(fileChanges, { repositoryId });
  for (const wf of workflowRuleFindings) {
    const alreadyExists = allFindings.some(
      (f) =>
        f.fileLocation === wf.fileLocation &&
        f.lineStart === wf.lineStart &&
        f.matchedSignatures?.some((s) => wf.matchedSignatures?.includes(s)),
    );
    if (!alreadyExists) {
      allFindings.push(wf);
    }
  }

  // Ensure deterministic IaC security rules are present (#2004)
  const iacOptions = resolveIacRuleOptions(repositoryGateConfig);
  const iacRuleFindings = runIacSecurityRules(fileChanges, {
    repositoryId,
    enabled: iacOptions.enabled,
    disabledRules: iacOptions.disabledRules,
  });
  for (const iac of iacRuleFindings) {
    const existingIndex = allFindings.findIndex(
      (f) =>
        (f.fileLocation === iac.fileLocation && f.lineStart === iac.lineStart) ||
        (f.dynamicFingerprint && f.dynamicFingerprint === iac.dynamicFingerprint) ||
        ((f as any).fingerprint && (f as any).fingerprint === (iac as any).fingerprint),
    );
    if (existingIndex >= 0) {
      // If it was an LLM finding, replace it with the deterministic rule finding to avoid duplicates
      const existing = allFindings[existingIndex];
      const isDeterministic = existing.matchedSignatures?.some((s) =>
        iac.matchedSignatures?.includes(s),
      );
      if (!isDeterministic) {
        allFindings[existingIndex] = iac;
      }
    } else {
      allFindings.push(iac);
    }
  }

  // Ensure deterministic dangerous pattern security rules are present (#2088)
  const patternOptions = resolvePatternRuleOptions(repositoryGateConfig);
  const patternRuleFindings = runPatternSecurityRules(fileChanges, {
    repositoryId,
    enabled: patternOptions.enabled,
    disabledRules: patternOptions.disabledRules,
  });
  for (const pat of patternRuleFindings) {
    const existingIndex = allFindings.findIndex(
      (f) =>
        (f.fileLocation === pat.fileLocation && f.lineStart === pat.lineStart) ||
        (f.dynamicFingerprint && f.dynamicFingerprint === pat.dynamicFingerprint) ||
        (f.fingerprint && f.fingerprint === pat.fingerprint),
    );
    if (existingIndex >= 0) {
      // If it was an LLM finding, replace it with the deterministic rule finding to avoid duplicates
      const existing = allFindings[existingIndex];
      const isDeterministic = existing.matchedSignatures?.some((s) =>
        pat.matchedSignatures?.includes(s),
      );
      if (!isDeterministic) {
        allFindings[existingIndex] = pat;
      }
    } else {
      allFindings.push(pat);
    }
  }

  // Ensure deterministic hidden Unicode / Trojan Source rules are present (#2089)
  const unicodeOptions = resolveUnicodeRuleOptions(repositoryGateConfig);
  const unicodeRuleFindings = runUnicodeSecurityRules(fileChanges, {
    repositoryId,
    enabled: unicodeOptions.enabled,
    disabledRules: unicodeOptions.disabledRules,
    allowPatterns: unicodeOptions.allowPatterns,
  });
  for (const uni of unicodeRuleFindings) {
    const existingIndex = allFindings.findIndex(
      (f) =>
        (f.fileLocation === uni.fileLocation && f.lineStart === uni.lineStart) ||
        (f.dynamicFingerprint && f.dynamicFingerprint === uni.dynamicFingerprint) ||
        (f.fingerprint && f.fingerprint === uni.fingerprint),
    );
    if (existingIndex >= 0) {
      // If it was an LLM finding, replace it with the deterministic rule finding to avoid duplicates
      const existing = allFindings[existingIndex];
      const isDeterministic = existing.matchedSignatures?.some((s) =>
        uni.matchedSignatures?.includes(s),
      );
      if (!isDeterministic) {
        allFindings[existingIndex] = uni;
      }
    } else {
      allFindings.push(uni);
    }
  }

  // Ensure obfuscation detection rules are present (#2090)
  const obfuscationFindings = runObfuscationSecurityRules(fileChanges, { repositoryId });
  for (const obf of obfuscationFindings) {
    const existingIndex = allFindings.findIndex(
      (f) =>
        (f.fileLocation === obf.fileLocation && f.lineStart === obf.lineStart) ||
        (f.dynamicFingerprint && f.dynamicFingerprint === obf.dynamicFingerprint) ||
        (f.fingerprint && f.fingerprint === obf.fingerprint),
    );
    if (existingIndex >= 0) {
      const existing = allFindings[existingIndex];
      const isDeterministic = existing.matchedSignatures?.some((s) => obf.matchedSignatures?.includes(s));
      if (!isDeterministic) allFindings[existingIndex] = obf;
    } else {
      allFindings.push(obf);
    }
  }

  // Ensure outbound-destination detection rules are present (#2091)
  const outboundFindings = runOutboundSecurityRules(fileChanges, { repositoryId });
  for (const out of outboundFindings) {
    const existingIndex = allFindings.findIndex(
      (f) =>
        (f.fileLocation === out.fileLocation && f.lineStart === out.lineStart) ||
        (f.dynamicFingerprint && f.dynamicFingerprint === out.dynamicFingerprint) ||
        (f.fingerprint && f.fingerprint === out.fingerprint),
    );
    if (existingIndex >= 0) {
      const existing = allFindings[existingIndex];
      const isDeterministic = existing.matchedSignatures?.some((s) => out.matchedSignatures?.includes(s));
      if (!isDeterministic) allFindings[existingIndex] = out;
    } else {
      allFindings.push(out);
    }
  }

  // Ensure sensitive filename detection rules are present (#2092)
  const sensitiveFileFindings = runSensitiveFileRules(fileChanges, { repositoryId });
  for (const sf of sensitiveFileFindings) {
    const existingIndex = allFindings.findIndex(
      (f) =>
        (f.fileLocation === sf.fileLocation && f.lineStart === sf.lineStart) ||
        (f.dynamicFingerprint && f.dynamicFingerprint === sf.dynamicFingerprint) ||
        (f.fingerprint && f.fingerprint === sf.fingerprint),
    );
    if (existingIndex >= 0) {
      const existing = allFindings[existingIndex];
      const isDeterministic = existing.matchedSignatures?.some((s) => sf.matchedSignatures?.includes(s));
      if (!isDeterministic) allFindings[existingIndex] = sf;
    } else {
      allFindings.push(sf);
    }
  }

  onProgress({
    phase: "enriching",
    scannedFiles: totalFiles,
    totalFiles,
    vulnerabilitiesFound: allFindings.length,
    progress: 90,
  });

  allFindings.forEach((f) => {
    f.fingerprint = computeFingerprint(repositoryId, f.fileLocation, f.type, f.codeSnippet);
  });

  const now = new Date();
  if (repositoryId) {
    await handleExpiredDismissals(repositoryId, allFindings, now, {
      prismaClient: prisma,
      repoFullName: repositoryFullName,
      userId,
    });
  }

  const suppressedFingerprints = new Set<string>();
  if (repositoryId) {
    const dismissed = await prisma.findingTriage.findMany({
      where: {
        repositoryId,
        ...activeSuppressionWhere(now),
      },
      select: { fingerprint: true },
    });
    dismissed.forEach((t: { fingerprint: string }) => suppressedFingerprints.add(t.fingerprint));
  }

  const nonDismissedFindings = allFindings.filter(
    (f) => !f.fingerprint || !suppressedFingerprints.has(f.fingerprint),
  );

  let activeFindings = nonDismissedFindings;
  let ruleSuppressedFindings: EnrichedScanFinding[] = [];

  try {
    const activeRules = await getActiveSuppressionRules(new Date());
    if (activeRules.length > 0) {
      const suppressionEval = evaluateSuppressionRules(
        nonDismissedFindings,
        activeRules,
        repositoryId,
        new Date(),
      );
      activeFindings = suppressionEval.activeFindings;
      ruleSuppressedFindings = suppressionEval.suppressedFindings;

      if (suppressionEval.ruleMatches.length > 0) {
        await recordSuppressionRuleEvents(
          suppressionEval.ruleMatches.map((m) => ({
            ruleId: m.rule.id,
            repositoryId,
            findingFingerprint: m.finding.fingerprint,
            fileLocation: m.finding.fileLocation,
          })),
        );
      }
    }
  } catch (err) {
    log.error("[ScanEngine] Failed evaluating suppression rules:", {
      error: err instanceof Error ? err.message : String(err),
    });
  }

  const enrichedFindings: EnrichedScanFinding[] = [];

  for (let i = 0; i < activeFindings.length; i += AI_ENRICHMENT_CONCURRENCY) {
    const batch = activeFindings.slice(i, i + AI_ENRICHMENT_CONCURRENCY);

    const batchResults = await Promise.all(
      batch.map(async (finding): Promise<EnrichedScanFinding> => {
        if (!enrich) return finding;
        try {
          const aiResponse = await developerReceivesAISecurityExplanations({
            findingType: finding.type,
            severity: finding.severity,
            description: finding.description,
            fileLocation: finding.fileLocation,
            codeSnippet: finding.codeSnippet || "",
          });
          return {
            ...finding,
            explanation: maskFindingText(aiResponse.explanation),
            remediation: maskFindingText(aiResponse.remediationSuggestions),
            promptInjectionSuspected: aiResponse.promptInjectionSuspected,
          };
        } catch (err) {
          log.error(`[ScanEngine] Failed to enrich finding:`, {
            error: err instanceof Error ? err.message : String(err),
          });
          console.error(`[ScanEngine] Failed to enrich finding:`, err);
          return finding;
        }
      }),
    );

    enrichedFindings.push(...batchResults);
  }

  // #2007: Run verification pass for CRITICAL findings before evaluating gate
  if (
    repositoryGateConfig.verifyCritical ||
    repositoryGateConfig.verifyCriticalFindings ||
    resolveVerifyCritical(repositoryGateConfig)
  ) {
    await verifyCriticalFindings(enrichedFindings, {
      gateConfig: repositoryGateConfig,
      fileChanges,
      policies: (activePolicies as any[]) || [],
    });
    for (let j = 0; j < activeFindings.length; j++) {
      if (enrichedFindings[j]) {
        activeFindings[j].verificationStatus = enrichedFindings[j].verificationStatus;
        activeFindings[j].verificationReason = enrichedFindings[j].verificationReason;
        activeFindings[j].verificationRawResponse = enrichedFindings[j].verificationRawResponse;
      }
    }
  }

  const decision = iq.evaluateFindings(enrichedFindings, repositoryGateConfig);
  const analyzedFilesCount = reusedFromCache ? totalFiles : allAnalyzedFiles.length;
  const zeroScanReason =
    analyzedFilesCount === 0 ? getZeroScanReason(fileChanges, customIgnores) : undefined;

  onProgress({
    phase: "posting",
    scannedFiles: totalFiles,
    totalFiles,
    vulnerabilitiesFound: enrichedFindings.length,
    progress: 95,
  });

  if (report) {
    try {
      const { owner, repo } = splitRepositoryFullName(repositoryFullName);
      const gateSummary = formatGateSummaryLine(repositoryGateConfig);

      const checkNoticeParts: string[] = [];
      if (gateSummary) checkNoticeParts.push(gateSummary);
      if (allSkippedFiles.length > 0) {
        checkNoticeParts.push(
          `⚠️ ${allSkippedFiles.length} file(s) were not scanned (oversized or scan deadline exceeded).`,
        );
      }
      const checkNotice = checkNoticeParts.length > 0 ? checkNoticeParts.join("\n\n") : undefined;

      const isPartialScan = budgetExceeded || allSkippedFiles.length > 0;

      await postScanCheckRun(octokit as any, {
        owner,
        repo,
        headSha,
        decision,
        findingsCount: enrichedFindings.length,
        fileCount: analyzedFilesCount,
        emptyReason: analyzedFilesCount === 0 ? zeroScanReason : undefined,
        notice: checkNotice,
        findings: enrichedFindings,
        isPartial: isPartialScan,
        unscannedFiles: allSkippedFiles,
        conclusion: isPartialScan ? "neutral" : undefined,
      });

      const expiredRules = repositoryIgnoreConfig.expiredRules ?? [];
      const previouslyDismissedCount = allFindings.length - nonDismissedFindings.length;

      const minConfidence = repositoryGateConfig.minCommentConfidence ?? "MEDIUM";
      const visibleFindings = enrichedFindings.filter((f) =>
        isConfidenceAtLeast(f.confidence, minConfidence),
      );
      const hiddenByConfidenceCount = enrichedFindings.length - visibleFindings.length;

      if (
        enrichedFindings.length > 0 ||
        allSkippedFiles.length > 0 ||
        expiredRules.length > 0 ||
        ruleSuppressedFindings.length > 0 ||
        analyzedFilesCount === 0 ||
        defaultSkippedCount > 0
      ) {
        const scanTime = new Date().toISOString();
        let body = `${SECUREFLOW_COMMENT_MARKER}\n### 🛡️ SecureFlow AI Security Report\n\n`;
        if (typeof formatScanMetadata === "function") {
          body += formatScanMetadata({ commitSha: headSha, scanTime });
        } else {
          if (headSha) {
            body += `Scanned commit: \`${headSha}\`\n`;
          }
          body += `Scan time: \`${scanTime}\`\n\n`;
        }
        if (enrichedFindings.length > 0) {
          body += `⚠️ Detected **${enrichedFindings.length}** potential issues matching your code policies.\n\n`;
        } else if (analyzedFilesCount === 0) {
          body += `⚪ Nothing to scan: ${zeroScanReason}.\n\n`;
        } else {
          body += `✅ No security vulnerabilities detected in scanned files.\n\n`;
        }

        if (defaultSkippedCount > 0) {
          body += `ℹ️ **${defaultSkippedCount} file${defaultSkippedCount === 1 ? "" : "s"}** skipped by default ignore patterns.\n\n`;
        }

        if (hiddenByConfidenceCount > 0) {
          body += `🛡️ **${hiddenByConfidenceCount} lower-confidence finding${hiddenByConfidenceCount === 1 ? "" : "s"}** below the \`${minConfidence}\` confidence threshold ${hiddenByConfidenceCount === 1 ? "was" : "were"} hidden from this comment (all findings remain visible in dashboard).\n\n`;
        }

        if (expiredRules.length > 0) {
          body += `### ⚠️ Expired Ignore Rules (${expiredRules.length})\n\n`;
          expiredRules.forEach((rule) => {
            const reasonText = rule.reason ? ` — reason: ${rule.reason}` : "";
            body += `- ⚠️ ignore rule \`${rule.pattern}\` expired on ${rule.expires}${reasonText}\n`;
          });
          body += `\n`;
        }

        if (appliedPolicyScopes.length > 0) {
          body += formatAppliedScopesSection(appliedPolicyScopes);
        }

        if (allSkippedFiles.length > 0) {
          body += `> ⚠️ **${allSkippedFiles.length} file(s) were not scanned** (too large or scan deadline exceeded):\n`;
          allSkippedFiles.forEach((f) => {
            body += `> - \`${f.filename}\` (${f.reason})\n`;
          });
          body += `\n`;
        }

        if (previouslyDismissedCount > 0) {
          body += `🛡️ **${previouslyDismissedCount} previously dismissed** finding(s) were suppressed for this repository.\n\n`;
        }

        if (ruleSuppressedFindings.length > 0) {
          body += `🛡️ **${ruleSuppressedFindings.length}** finding(s) were suppressed by installation suppression rule(s).\n\n`;
        }

        const appUrl = (process.env.NEXT_PUBLIC_APP_URL || "").replace(/\/+$/, "");

        visibleFindings.forEach((f) => {
          body += `#### ${severityBadge(f.severity)} | **${f.type}** in \`${f.fileLocation}\`\n`;
          const findingId = (f as any).id;
          if (findingId) {
            body += `🔗 [View Finding Details](${appUrl}/dashboard/findings/${findingId})\n\n`;
          }
          if (f.verificationStatus === "UNVERIFIED") {
            body += `> ℹ️ **Verification: UNVERIFIED (Non-blocking)**${f.verificationReason ? ` — Reason: ${f.verificationReason}` : ""}\n\n`;
          } else if (f.verificationStatus === "CONFIRMED") {
            body += `> 🛡️ **Verification: CONFIRMED**${f.verificationReason ? ` — Reason: ${f.verificationReason}` : ""}\n\n`;
          }
          if (f.confidence) {
            const reasonSuffix = f.confidenceReason ? ` — ${f.confidenceReason}` : "";
            body += `> **Confidence:** ${f.confidence}${reasonSuffix}\n\n`;
          }
          if (f.promptInjectionSuspected) {
            body += `> ⚠️ **AI explanation may be unreliable for this finding — verify manually.**\n\n`;
          }
          body += `> ${f.explanation ?? f.description}\n\n`;
          body += `---\n\n`;
        });

        await upsertSecureFlowComment(octokit, {
          owner,
          repo,
          issueNumber: prNumber,
          body,
        });

        // Post suggested changes as inline review comments when enabled (#2005)
        const suggestionsConfig = resolveSuggestionsConfig(repositoryGateConfig);
        if (
          suggestionsConfig.enabled &&
          fileChanges.length > 0 &&
          typeof octokit?.rest?.pulls?.createReview === "function"
        ) {
          const commentableLinesByFile = new Map<string, Set<number>>();
          for (const file of fileChanges) {
            if (file.patch) {
              commentableLinesByFile.set(
                file.filename,
                commentableLineNumbers(parseUnifiedPatch(file.patch)),
              );
            }
          }

          const { inlineComments } = buildInlineReviewComments(
            enrichedFindings,
            commentableLinesByFile,
            { suggestionsConfig },
          );

          if (inlineComments.length > 0) {
            await postSuggestedChangesReview(octokit, {
              owner,
              repo,
              pullNumber: prNumber,
              commitId: headSha,
              comments: inlineComments,
            });
          }
        }
      }
    } catch (err) {
      log.error(`[ScanEngine] Failed to post to GitHub:`, {
        error: err instanceof Error ? err.message : String(err),
      });
      console.error(`[ScanEngine] Failed to post to GitHub:`, err);
    }
  }

  let persistenceError: string | null = null;
  let dbPrRecord: any = null;
  let createdScanResult: any = null;

  if (persist && repositoryId) {
    try {
      const dbPr = await resolvePullRequestRecord({
        store: prisma.pullRequest as never,
        fetchPullRequest: (params) => octokit.rest.pulls.get(params) as never,
        repositoryId,
        repositoryFullName,
        prNumber,
      });
      dbPrRecord = dbPr;

      const suppressedFindings = allFindings.filter(
        (f) => f.fingerprint && suppressedFingerprints.has(f.fingerprint),
      );
      const findingsToPersist = [
        ...enrichedFindings,
        ...suppressedFindings,
        ...ruleSuppressedFindings,
      ];

      const isPartialScan = budgetExceeded || allSkippedFiles.length > 0;
      const scanGateConfig = isPartialScan
        ? {
            ...repositoryGateConfig,
            isPartialScan: true,
            isPartial: true,
            skippedFiles: allSkippedFiles.map((f) => f.filename),
          }
        : repositoryGateConfig;

      createdScanResult = await prisma.scanResult.create({
        data: scanResultCreateData({
          pullRequestId: dbPr.id,
          headSha,
          gateConfig: scanGateConfig,
          decision,
          scoredFindings: activeFindings,
          findingsToPersist,
        }),
      });

      if (
        (prisma as any).storedScanInput &&
        typeof (prisma as any).storedScanInput.create === "function" &&
        fileChanges.length > 0
      ) {
        const effectiveContext = resolveContextLines(repositoryGateConfig.contextLines);
        const tokenEstimate = fileChanges.reduce(
          (sum, f) =>
            sum +
            estimateDiffTokens(f.patch, {
              contextLines: effectiveContext,
              fullContent: (f as any).content,
            }),
          0,
        );
        await (prisma as any).storedScanInput
          .create({
            data: {
              repositoryId,
              pullRequestId: dbPr.id,
              headSha,
              filesJson: JSON.stringify(fileChanges),
              tokenEstimate,
            },
          })
          .catch((err: any) => {
            log.warn(`[ScanEngine] Failed to persist stored scan input:`, {
              error: err instanceof Error ? err.message : String(err),
            });
          });
      }

      await autoResolveFixedFindings({
        repositoryId,
        pullRequestId: dbPr.id,
        headSha,
        currentFindings: allFindings,
        fileChanges,
        isPartialScan,
        userId,
        repoFullName: repositoryFullName,
      }).catch((err) => {
        log.warn(`[ScanEngine] Failed to auto-resolve fixed findings:`, {
          error: err instanceof Error ? err.message : String(err),
        });
      });

      if (userId) {
        await prisma.auditLog.create({
          data: sanitizeAuditLogInput({
            userId,
            action: reusedFromCache
              ? "Background Scan Completed (reused from cache)"
              : "Background Scan Completed",
            resource: `${repositoryFullName}#${prNumber}`,
            decision,
            metadata: {
              correlationId,
              scanJobId,
              deliveryId: data.deliveryId,
              findingsCount: enrichedFindings.length,
              totalFiles,
              riskScore: storedRiskScore(activeFindings),
              reusedFromCache,
              cacheHit: reusedFromCache,
              cacheStatus: reusedFromCache ? "reused from cache" : "fresh scan",
            },
          }),
        });
      }
    } catch (err) {
      persistenceError = err instanceof Error ? err.message : String(err);
      log.error(`[ScanEngine] Failed to persist results:`, { error: persistenceError });
      console.error(`[ScanEngine] Failed to persist results:`, err);
    }
  }

  if (userId && enrichedFindings.length > 0) {
    try {
      const owner = await prisma.user.findUnique({
        where: { id: userId },
        select: { slackWebhookUrl: true },
      });

      await notifyHighSeverityFindings(owner?.slackWebhookUrl, {
        repositoryFullName,
        prNumber,
        findings: enrichedFindings,
      });

      // Dispatch Slack or Discord webhook alert for newly introduced critical findings
      await dispatchCriticalChatAlert({
        userId,
        repositoryId,
        repositoryFullName,
        pullRequestId: dbPrRecord?.id,
        prNumber,
        findings: enrichedFindings,
        currentScanResultId: createdScanResult?.id,
      });
    } catch (err) {
      log.error(`[ScanEngine] Slack notification step failed:`, {
        error: err instanceof Error ? err.message : String(err),
      });
      console.error(`[ScanEngine] Slack notification step failed:`, err);
    }

    const isBlockedDecision = decision === "BLOCKED" || storedPolicyDecision(decision) === "BLOCK";

    if (isBlockedDecision) {
      try {
        await notifyBlockedScan({
          scanJobId,
          deliveryId: data.deliveryId,
          correlationId,
          userId,
          repositoryFullName,
          prNumber,
          findings: enrichedFindings,
          decision,
        });
      } catch (err) {
        log.error(`[ScanEngine] Blocked scan notification failed:`, {
          error: err instanceof Error ? err.message : String(err),
        });
        console.error(`[ScanEngine] Blocked scan notification failed:`, err);
      }
    }
  }

  onProgress({
    phase: "completed",
    scannedFiles: totalFiles,
    totalFiles,
    vulnerabilitiesFound: enrichedFindings.length,
    progress: 100,
  });

  const riskScore = storedRiskScore(activeFindings);

  log.info(
    `[ScanEngine] Scan complete: ${enrichedFindings.length} findings, risk=${riskScore}, decision=${decision}`,
  );
  console.log(
    `[ScanEngine] Scan complete: ${enrichedFindings.length} findings, risk=${riskScore}, decision=${decision}`,
  );

  if (persistenceError) {
    throw new ScanPersistenceError(persistenceError);
  }

  return {
    scanJobId,
    scannedFiles: analyzedFilesCount,
    analyzedFiles: allAnalyzedFiles,
    vulnerabilitiesFound: enrichedFindings.length,
    riskScore,
    policyDecision: storedPolicyDecision(decision),
    verdict: decision,
    findings: enrichedFindings,
    skippedFiles: allSkippedFiles,
    isPartial: budgetExceeded || allSkippedFiles.length > 0,
    timedOut: budgetExceeded,
    reusedFromCache,
    expiredIgnoreRules: repositoryIgnoreConfig.expiredRules ?? [],
    appliedPolicyScopes,
    zeroScanReason,
    defaultSkippedCount,
  };
}
