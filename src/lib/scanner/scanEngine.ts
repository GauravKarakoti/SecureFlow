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

import { scanner, type FileChange, type ScanFinding } from '@/lib/armor/scanner';
import { iq } from '@/lib/armor/iq';
import { computeFingerprint } from '@/lib/armor/fingerprint';
import { developerReceivesAISecurityExplanations } from '@/ai/flows/developer-receives-ai-security-explanations';
import { maskFindingText } from '@/lib/armor/secret-masking';
import prisma from '@/lib/prisma';
import { sanitizeAuditLogInput } from '@/lib/audit/minimization';
import { severityBadge, toStoredSeverity, totalRiskScore } from '@/lib/severity';
import { App } from 'octokit';
import { getGitHubAppCredentials } from '@/lib/queue/worker';
import { fetchPullRequestFiles, formatCoverageNotice } from '@/lib/github/pull-request-files';
import type { ScanJobData } from '@/lib/queue/scanQueue';
import { updateScanJobProgress } from '@/lib/queue/scanQueue';

/** Maximum files to process in a single batch before yielding. */
const CHUNK_SIZE = 10;

/** Delay between chunks to avoid overwhelming the LLM API. */
const CHUNK_DELAY_MS = 100;

export interface ScanJobResult {
  scanJobId: string;
  scannedFiles: number;
  vulnerabilitiesFound: number;
  riskScore: number;
  policyDecision: string;
  findings: ScanFinding[];
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
  onProgress: ProgressCallback = () => {}
): Promise<ScanJobResult> {
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
  const octokit = await appClient.getInstallationOctokit(Number(installationId));

  // If no file changes provided, fetch from GitHub
  let fileChanges = initialFileChanges;
  if (fileChanges.length === 0) {
    const [owner, repo] = repositoryFullName.split('/');
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

  const allFindings: ScanFinding[] = [];
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
    const progress = Math.round((scannedFiles / totalFiles) * 100);

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

  // Compute fingerprints
  allFindings.forEach(f => {
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
    dismissed.forEach((t: { fingerprint: string }) => { if (t.fingerprint) suppressedFingerprints.add(t.fingerprint); });
  }

  const activeFindings = allFindings.filter(f => !f.fingerprint || !suppressedFingerprints.has(f.fingerprint));

  // Enrich active findings with AI explanations
  const enrichedFindings = await Promise.all(
    activeFindings.map(async (finding) => {
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
  const policyDecision = decision === 'PASS' ? 'success' : decision === 'REVIEW REQUIRED' ? 'action_required' : 'failure';

  // --- Phase 5: Post to GitHub ---
  onProgress({ phase: 'posting', scannedFiles: totalFiles, totalFiles, vulnerabilitiesFound: enrichedFindings.length, progress: 95 });

  try {
    const [owner, repo] = repositoryFullName.split('/');

    // Create check run
    await octokit.rest.checks.create({
      owner,
      repo,
      name: 'SecureFlow Scan',
      head_sha: headSha,
      status: 'completed',
      conclusion: policyDecision as any,
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

  // --- Phase 6: Persist to database ---
  if (repositoryId) {
    try {
      const riskScore = totalRiskScore(activeFindings);

      // Find or create PullRequest record
      let dbPr = await prisma.pullRequest.findFirst({
        where: {
          repositoryId,
          number: prNumber,
        },
      });

      if (!dbPr) {
        dbPr = await prisma.pullRequest.create({
          data: {
            repositoryId,
            githubId: BigInt(0),
            number: prNumber,
            title: `PR #${prNumber}`,
            state: 'OPEN',
            headSha,
          },
        });
      }

      // Create ScanResult with findings
      const suppressedFindings = allFindings.filter(f => Boolean(f.fingerprint && suppressedFingerprints.has(f.fingerprint)));
      const findingsToPersist = [...enrichedFindings, ...suppressedFindings];

      await prisma.scanResult.create({
        data: {
          pullRequestId: dbPr.id,
          riskScore,
          policyDecision: decision as any,
          findings: {
            create: findingsToPersist.map(f => ({
              type: f.type as any,
              severity: toStoredSeverity(f.severity) as any,
              fileLocation: f.fileLocation,
              lineStart: f.lineStart,
              lineEnd: f.lineEnd,
              codeSnippet: f.codeSnippet,
              fingerprint: f.fingerprint ?? '',
            })),
          },
        },
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
              riskScore,
            },
          }),
        });
      }
    } catch (err) {
      console.error(`[ScanEngine] Failed to persist results:`, err);
    }
  }

  // --- Done ---
  onProgress({ phase: 'completed', scannedFiles: totalFiles, totalFiles, vulnerabilitiesFound: enrichedFindings.length, progress: 100 });

  const riskScore = totalRiskScore(activeFindings);

  console.log(`[ScanEngine] Scan complete: ${enrichedFindings.length} findings, risk=${riskScore}, decision=${decision}`);

  return {
    scanJobId,
    scannedFiles: totalFiles,
    vulnerabilitiesFound: enrichedFindings.length,
    riskScore,
    policyDecision: decision,
    findings: enrichedFindings,
  };
}
