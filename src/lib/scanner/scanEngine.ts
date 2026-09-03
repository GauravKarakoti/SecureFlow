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

import { scanner } from '@/lib/armor/scanner';
import { iq } from '@/lib/armor/iq';
import { computeFingerprint } from '@/lib/armor/fingerprint';
import { developerReceivesAISecurityExplanations } from '@/ai/flows/developer-receives-ai-security-explanations';
import { maskFindingText } from '@/lib/armor/secret-masking';
import prisma from '@/lib/prisma';
import { sanitizeAuditLogInput } from '@/lib/audit/minimization';
import { severityBadge } from '@/lib/severity';
import { App } from 'octokit';
import { getGitHubAppCredentials } from '@/lib/queue/worker';
import { fetchPullRequestFiles } from '@/lib/github/pull-request-files';
import type { ScanJobData } from '@/lib/queue/scanQueue';
import { updateScanJobProgress } from '@/lib/queue/scanQueue';
import {
  checkRunConclusion,
  parseInstallationId,
  progressPercent,
  scanResultCreateData,
  ScanPersistenceError,
  storedPolicyDecision,
  storedRiskScore,
  type EnrichedScanFinding,
} from './scan-persistence';
import { resolvePullRequestRecord, splitRepositoryFullName } from './pull-request-record';

/** Maximum files to process in a single batch before yielding. */
const CHUNK_SIZE = 10;

/** Delay between chunks to avoid overwhelming the LLM API. */
const CHUNK_DELAY_MS = 100;

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
  policyDecision: 'PASS' | 'REVIEW' | 'BLOCK';
  /** The scanner's verdict as `iq.evaluateFindings` phrased it, for logs and copy. */
  verdict: string;
  findings: EnrichedScanFinding[];
}

export interface ScanProgress {
  phase: 'starting' | 'scanning' | 'enriching' | 'posting' | 'completed';
  scannedFiles: number;
  totalFiles: number;
  vulnerabilitiesFound: number;
  progress: number;
}

type ProgressCallback = (progress: ScanProgress) => void;

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
  options: ProcessScanJobOptions = {}
): Promise<ScanJobResult> {
  const { report = true, persist = true } = options;
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
  onProgress({ phase: 'starting', scannedFiles: 0, totalFiles: initialFileChanges.length, vulnerabilitiesFound: 0, progress: 0 });

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
      .filter((f: any) => f.patch && f.status !== 'removed')
      .map((f: any) => ({ filename: f.filename, patch: f.patch }));
  }

  // --- Phase 2: Run scanner on file changes ---
  onProgress({ phase: 'scanning', scannedFiles: 0, totalFiles: fileChanges.length, vulnerabilitiesFound: 0, progress: 10 });

  const totalFiles = fileChanges.length;
  console.log(`[ScanEngine] Scanning ${totalFiles} files`);

  // --- Phase 2: Scan files in chunks ---
  onProgress({ phase: 'scanning', scannedFiles: 0, totalFiles, vulnerabilitiesFound: 0, progress: 0 });

  const allFindings: EnrichedScanFinding[] = [];
  let scannedFiles = 0;

  for (let i = 0; i < fileChanges.length; i += CHUNK_SIZE) {
    const chunk = fileChanges.slice(i, i + CHUNK_SIZE);

    try {
      const chunkFindings = await scanner.scanPullRequest(
        chunk,
        activePolicies as any[],
        customIgnores,
        customPlaceholders
      );
      allFindings.push(...chunkFindings);
    } catch (err) {
      console.error(`[ScanEngine] Error scanning chunk ${i}-${i + chunk.length}:`, err);
      // Continue with next chunk — partial results are better than no results
    }

    scannedFiles = Math.min(i + CHUNK_SIZE, totalFiles);
    const vulnCount = allFindings.length;
    const progress = progressPercent(scannedFiles, totalFiles);

    onProgress({
      phase: 'scanning',
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
      await new Promise(resolve => setTimeout(resolve, CHUNK_DELAY_MS));
    }
  }

  // --- Phase 3: Enrich findings with AI explanations ---
  onProgress({ phase: 'enriching', scannedFiles: totalFiles, totalFiles, vulnerabilitiesFound: allFindings.length, progress: 90 });

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
        status: { in: ['FALSE_POSITIVE', 'IGNORED'] },
      },
      select: { fingerprint: true },
    });
    dismissed.forEach((t: { fingerprint: string }) => suppressedFingerprints.add(t.fingerprint));
  }

  const activeFindings = allFindings.filter(
    (f) => !f.fingerprint || !suppressedFingerprints.has(f.fingerprint)
  );

  // Enrich active findings with AI explanations
  const enrichedFindings: EnrichedScanFinding[] = await Promise.all(
    activeFindings.map(async (finding): Promise<EnrichedScanFinding> => {
      try {
        const aiResponse = await developerReceivesAISecurityExplanations({
          findingType: finding.type,
          severity: finding.severity,
          description: finding.description,
          fileLocation: finding.fileLocation,
          codeSnippet: finding.codeSnippet || '',
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
    })
  );

  // --- Phase 4: Evaluate policy decision ---
  const decision = iq.evaluateFindings(activeFindings);
  // Both the check-run conclusion and the stored enum are derived from the same
  // normalizer, so they can no longer disagree about what the scan decided.
  const conclusion = checkRunConclusion(decision);

  // --- Phase 5: Post to GitHub ---
  onProgress({ phase: 'posting', scannedFiles: totalFiles, totalFiles, vulnerabilitiesFound: enrichedFindings.length, progress: 95 });

  if (report) {
    try {
      const { owner, repo } = splitRepositoryFullName(repositoryFullName);

      // Create check run
      await octokit.rest.checks.create({
        owner,
        repo,
        name: 'SecureFlow Scan',
        head_sha: headSha,
        status: 'completed',
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

        enrichedFindings.forEach(f => {
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
        (f) => f.fingerprint && suppressedFingerprints.has(f.fingerprint)
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
            action: 'Background Scan Completed',
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

  // --- Done ---
  onProgress({ phase: 'completed', scannedFiles: totalFiles, totalFiles, vulnerabilitiesFound: enrichedFindings.length, progress: 100 });

  const riskScore = storedRiskScore(activeFindings);

  console.log(`[ScanEngine] Scan complete: ${enrichedFindings.length} findings, risk=${riskScore}, decision=${decision}`);

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
