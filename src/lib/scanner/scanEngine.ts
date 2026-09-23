/**
 * Scan Engine — Processes scan jobs with chunked file processing and progress reporting.
 *
 * Refactors the synchronous scanPullRequest flow into an async, queue-compatible
 * pipeline that reports progress as files are scanned.
 *
 * Usage (from worker):
 *   import { processScanJob } from '@/lib/scanner/scanEngine';
 *   const result = await processScanJob(jobData, onProgress);
 */

import { scanner } from "@/lib/armor/scanner";
import { iq } from "@/lib/armor/iq";
import { computeFingerprint } from "@/lib/armor/fingerprint";
import { developerReceivesAISecurityExplanations } from "@/ai/flows/developer-receives-ai-security-explanations";
import { maskFindingText } from "@/lib/armor/secret-masking";
import prisma from "@/lib/prisma";
import { sanitizeAuditLogInput } from "@/lib/audit/minimization";
import { severityBadge } from "@/lib/severity";
import { App } from "octokit";
import { getGitHubAppCredentials } from "@/lib/queue/worker";
import { fetchPullRequestFiles } from "@/lib/github/pull-request-files";
import type { ScanJobData } from "@/lib/queue/scanQueue";
import { updateScanJobProgress } from "@/lib/queue/scanQueue";
import {
  checkRunConclusion,
  parseInstallationId,
  progressPercent,
  scanResultCreateData,
  ScanPersistenceError,
  storedPolicyDecision,
  storedRiskScore,
  type EnrichedScanFinding,
} from "./scan-persistence";
import { resolvePullRequestRecord, splitRepositoryFullName } from "./pull-request-record";
import { notifyHighSeverityFindings } from "@/lib/integrations/slack";

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
  /**
   * The stored `PolicyDecision` member, not the scanner's phrasing.
   *
   * `workerPool` writes this straight into `ScanJob.policyDecision`, so the
   * conversion belongs here rather than at that call site — returning
   * `'REVIEW REQUIRED'` from a field typed `string` is what made every non-PASS
   * scan fail its completion update (#747).
   */
  policyDecision: "PASS" | "REVIEW" | "BLOCK";
  /** The scanner's verdict as `iq.evaluateFindings` phrased it, for logs and copy. */
  verdict: string;
  findings: EnrichedScanFinding[];
}

export interface ScanProgress {
  phase: "starting" | "scanning" | "enriching" | "posting" | "completed";
  scannedFiles: number;
  totalFiles: number;
  vulnerabilitiesFound: number;
  progress: number;
}

type ProgressCallback = (progress: ScanProgress) => void;

/**
 * A chunk of the pull request could not be scanned.
 *
 * `scanner.scanPullRequest` throws once its own retries are exhausted precisely so a scan
 * the LLM never completed cannot be reported as clean (6452440). Swallowing that error
 * here and carrying on turned an unavailable analysis engine back into a `PASS` check
 * run with zero findings, for the webhook worker as well as the queued path.
 */
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

/**
 * Which of the engine's side effects to run.
 *
 * `src/lib/queue/worker.ts` calls `processScanJob` for the scanning and then
 * does its own reporting and persistence: it posts a check run, updates the
 * pending pull request comment with inline review annotations, writes the
 * `AuditLog` row and creates the `ScanResult`. Every one of those is also a
 * phase of this function.
 *
 * That duplication has been invisible so far only because both of the engine's
 * writes failed: the check run and comment were posted twice, and the
 * persistence phase threw on a column name (#747) and was swallowed. Fixing the
 * persistence would have turned a latent duplicate into two `ScanResult` rows
 * per webhook scan, so the caller now says which half of the work it wants.
 *
 * Both default to `true`, which is what the queued path (`/api/findings` →
 * `workerPool`) needs — it has no other reporting of its own.
 */
export interface ProcessScanJobOptions {
  /** Post the GitHub check run and pull request comment. */
  report?: boolean;
  /** Write the `PullRequest`, `ScanResult`, `Finding` and `AuditLog` rows. */
  persist?: boolean;
  /**
   * Request an AI explanation for each active finding.
   *
   * The webhook worker explains the findings itself (and masks the output) before it
   * posts them, so enriching here as well paid for every explanation twice and threw
   * the first copy away.
   */
  enrich?: boolean;
}

/**
 * Process a scan job from the queue.
 *
 * This is the main entry point for background scan processing. It:
 * 1. Fetches PR files from GitHub
 * 2. Scans files in chunks with progress reporting
 * 3. Enriches findings with AI explanations
 * 4. Posts results to GitHub (PR comment/check)
 * 5. Persists results to the database
 */
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
    fileChanges: initialFileChanges,
    activePolicies,
    customIgnores,
    customPlaceholders,
    userId,
  } = data;

  console.log(`[ScanEngine] Starting scan for ${repositoryFullName}#${prNumber}`);

  // --- Phase 1: Fetch files from GitHub ---
  onProgress({
    phase: "starting",
    scannedFiles: 0,
    totalFiles: initialFileChanges.length,
    vulnerabilitiesFound: 0,
    progress: 0,
  });

  const { appId, privateKey } = getGitHubAppCredentials();
  const appClient = new App({ appId, privateKey });
  // Narrowed rather than asserted: `installationId` is `number | string` because
  // the route accepts either and BullMQ round-trips job data through JSON.
  const octokit = await appClient.getInstallationOctokit(parseInstallationId(installationId));

  // If no file changes provided, fetch from GitHub
  let fileChanges = initialFileChanges;
  if (fileChanges.length === 0) {
    const { owner, repo } = splitRepositoryFullName(repositoryFullName);
    const result = await fetchPullRequestFiles(octokit as any, {
      owner,
      repo,
      pullNumber: prNumber,
    });
    fileChanges = result.files
      .filter((f: any) => f.patch && f.status !== "removed")
      .map((f: any) => ({ filename: f.filename, patch: f.patch }));
  }

  const totalFiles = fileChanges.length;
  console.log(`[ScanEngine] Scanning ${totalFiles} files`);

  // --- Phase 2: Scan files in chunks ---
  onProgress({
    phase: "scanning",
    scannedFiles: 0,
    totalFiles,
    vulnerabilitiesFound: 0,
    progress: 0,
  });

  const allFindings: EnrichedScanFinding[] = [];
  let scannedFiles = 0;

  for (let i = 0; i < fileChanges.length; i += CHUNK_SIZE) {
    const chunk = fileChanges.slice(i, i + CHUNK_SIZE);

    try {
      const chunkFindings = await scanner.scanPullRequest(
        chunk,
        activePolicies as any[],
        customIgnores,
        customPlaceholders,
      );
      allFindings.push(...chunkFindings);
    } catch (err) {
      console.error(`[ScanEngine] Error scanning chunk ${i}-${i + chunk.length}:`, err);
      // Fail the scan rather than continue: findings from the other chunks would be
      // evaluated as if these files were clean, and a PR whose risky file sat in this
      // chunk would pass.
      throw new ScanIncompleteError(
        chunk.map((file) => file.filename),
        err,
      );
    }

    scannedFiles = Math.min(i + CHUNK_SIZE, totalFiles);
    const vulnCount = allFindings.length;
    const progress = progressPercent(scannedFiles, totalFiles);

    onProgress({
      phase: "scanning",
      scannedFiles,
      totalFiles,
      vulnerabilitiesFound: vulnCount,
      progress,
    });

    // Update database progress
    await updateScanJobProgress(scanJobId, {
      scannedFiles,
      vulnerabilitiesFound: vulnCount,
    }).catch(() => {});

    // Yield to event loop between chunks
    if (i + CHUNK_SIZE < fileChanges.length) {
      await new Promise((resolve) => setTimeout(resolve, CHUNK_DELAY_MS));
    }
  }

  // --- Phase 3: Enrich findings with AI explanations ---
  onProgress({
    phase: "enriching",
    scannedFiles: totalFiles,
    totalFiles,
    vulnerabilitiesFound: allFindings.length,
    progress: 90,
  });

  // Compute fingerprints. `EnrichedScanFinding` declares the field; `ScanFinding`
  // does not, which is what made this assignment a type error (#747).
  allFindings.forEach((f) => {
    f.fingerprint = computeFingerprint(repositoryId, f.fileLocation, f.type, f.codeSnippet);
  });

  // Check for suppressed (dismissed) findings
  const suppressedFingerprints = new Set<string>();
  if (repositoryId) {
    const dismissed = await prisma.findingTriage.findMany({
      where: {
        repositoryId,
        status: { in: ["FALSE_POSITIVE", "IGNORED"] },
      },
      select: { fingerprint: true },
    });
    dismissed.forEach((t: { fingerprint: string }) => suppressedFingerprints.add(t.fingerprint));
  }

  const activeFindings = allFindings.filter(
    (f) => !f.fingerprint || !suppressedFingerprints.has(f.fingerprint),
  );

  // Enrich active findings with AI explanations.
  //
  // Previously used Promise.all over all findings simultaneously. On a PR with
  // many findings this fired all AI calls at once, immediately exhausting the
  // Groq rate limit (429) and causing every call to fail and retry at the same
  // time — a thundering herd that made the problem worse with each retry cycle.
  //
  // Fixed by processing findings in batches of AI_ENRICHMENT_CONCURRENCY (3).
  // Each batch runs in parallel (fast), but batches are sequential (safe).
  // This keeps Groq request rate well within limits while still being faster
  // than fully sequential processing.
  // Enrich active findings with AI explanations in batches to prevent rate-limit storms (thundering herd)
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
          console.error(`[ScanEngine] Failed to enrich finding:`, err);
          return finding;
        }
      }),
    );

    enrichedFindings.push(...batchResults);
  }

  // --- Phase 4: Evaluate policy decision ---
  const decision = iq.evaluateFindings(activeFindings);
  // Both the check-run conclusion and the stored enum are derived from the same
  // normalizer, so they can no longer disagree about what the scan decided.
  const conclusion = checkRunConclusion(decision);

  // --- Phase 5: Post to GitHub ---
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

      // Create check run
      await octokit.rest.checks.create({
        owner,
        repo,
        name: "SecureFlow Scan",
        head_sha: headSha,
        status: "completed",
        conclusion,
        output: {
          title: `Policy Decision: ${decision}`,
          summary: `SecureFlow detected ${enrichedFindings.length} potential security issues across ${totalFiles} analyzed file(s).`,
        },
      });

      // Post PR comment if there are findings
      if (enrichedFindings.length > 0) {
        let body = `### 🛡️ SecureFlow AI Security Report\n\n`;
        body += `⚠️ Detected **${enrichedFindings.length}** potential issues matching your code policies.\n\n`;

        enrichedFindings.forEach((f) => {
          body += `#### ${severityBadge(f.severity)} | **${f.type}** in \`${f.fileLocation}\`\n`;
          if (f.promptInjectionSuspected) {
            body += `> ⚠️ **AI explanation may be unreliable for this finding — verify manually.**\n\n`;
          }
          body += `> ${f.explanation ?? f.description}\n\n`;
          body += `---\n\n`;
        });

        await octokit.rest.issues.createComment({
          owner,
          repo,
          issue_number: prNumber,
          body,
        });
      }
    } catch (err) {
      console.error(`[ScanEngine] Failed to post to GitHub:`, err);
      // Don't throw — the scan results are still valid even if posting fails
    }
  }

  // --- Phase 6: Persist to database ---
  let persistenceError: string | null = null;

  if (persist && repositoryId) {
    try {
      // Resolved against `prNumber` — the column's actual name — and created
      // with the pull request's real GitHub id rather than `BigInt(0)`, which
      // is `@unique` and so worked at most once per database (#747).
      const dbPr = await resolvePullRequestRecord({
        store: prisma.pullRequest as never,
        fetchPullRequest: (params) => octokit.rest.pulls.get(params) as never,
        repositoryId,
        repositoryFullName,
        prNumber,
      });

      // Suppressed findings are still stored, so a reversed triage decision does
      // not lose its history, but they are excluded from the score.
      const suppressedFindings = allFindings.filter(
        (f) => f.fingerprint && suppressedFingerprints.has(f.fingerprint),
      );
      const findingsToPersist = [...enrichedFindings, ...suppressedFindings];

      await prisma.scanResult.create({
        data: scanResultCreateData({
          pullRequestId: dbPr.id,
          decision,
          scoredFindings: activeFindings,
          findingsToPersist,
        }),
      });

      // Audit log
      if (userId) {
        await prisma.auditLog.create({
          data: sanitizeAuditLogInput({
            userId,
            action: "Background Scan Completed",
            resource: `${repositoryFullName}#${prNumber}`,
            decision,
            metadata: {
              findingsCount: enrichedFindings.length,
              totalFiles,
              riskScore: storedRiskScore(activeFindings),
            },
          }),
        });
      }
    } catch (err) {
      // Recorded rather than only logged. Every write above is an enum or a
      // column name away from being rejected outright, and the previous
      // log-and-continue meant the job still reported COMPLETED with nothing in
      // the database — the failure mode was indistinguishable from a clean scan
      // of a repository with no findings (#747).
      persistenceError = err instanceof Error ? err.message : String(err);
      console.error(`[ScanEngine] Failed to persist results:`, err);
    }
  }

  // --- Phase 7: Real-time Slack alert for high-severity findings (#936) ---
  //
  // Runs after persistence so an alert only fires for findings that are already
  // saved, and is deliberately outside the persist try/catch: it is best-effort
  // and `notifyHighSeverityFindings` never throws, so a Slack outage cannot turn
  // a completed scan into a failed one or trigger a BullMQ retry. The threshold
  // (CRITICAL/HIGH) is decided inside the integration.
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
    } catch (err) {
      // Includes the webhook lookup — a Slack step must never fail the scan.
      console.error(`[ScanEngine] Slack notification step failed:`, err);
    }
  }

  // --- Done ---
  onProgress({
    phase: "completed",
    scannedFiles: totalFiles,
    totalFiles,
    vulnerabilitiesFound: enrichedFindings.length,
    progress: 100,
  });

  const riskScore = storedRiskScore(activeFindings);

  console.log(
    `[ScanEngine] Scan complete: ${enrichedFindings.length} findings, risk=${riskScore}, decision=${decision}`,
  );

  if (persistenceError) {
    throw new ScanPersistenceError(persistenceError);
  }

  return {
    scanJobId,
    scannedFiles: totalFiles,
    vulnerabilitiesFound: enrichedFindings.length,
    riskScore,
    policyDecision: storedPolicyDecision(decision),
    verdict: decision,
    findings: enrichedFindings,
  };
}
