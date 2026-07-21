import { Worker, Job } from 'bullmq';
import { redis } from './redis';
import { webhookDLQ } from './webhookQueue';
import { scanner, parseSecureFlowIgnore } from '@/lib/armor/scanner';
import { iq } from '@/lib/armor/iq';
import { computeFingerprint } from '@/lib/armor/fingerprint';
import { developerReceivesAISecurityExplanations } from '@/ai/flows/developer-receives-ai-security-explanations';
import { App } from 'octokit';
import prisma from '@/lib/prisma';

/**
 * Parse a unified-diff patch and return the set of new-file line numbers that
 * are addressable by a GitHub review comment. GitHub only accepts inline review
 * comments on lines that appear in the diff (added `+` lines or context lines);
 * a comment on any other line is rejected and would fail the whole review call.
 */
export function getCommentableLines(patch: string): Set<number> {
  const lines = new Set<number>();
  let newLine = 0;
  for (const row of patch.split('\n')) {
    const hunk = row.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
    if (hunk) {
      newLine = parseInt(hunk[1], 10);
      continue;
    }
    if (row.startsWith('-')) {
      // Removed line: exists only on the old side, not addressable via `line`.
      continue;
    }
    if (row.startsWith('+') || row.startsWith(' ')) {
      // Added or context line: part of the diff on the new side.
      lines.add(newLine);
      newLine++;
    }
  }
  return lines;
}

export const worker = new Worker('github-webhooks', async (job: Job) => {
  const { payload, event } = job.data;

  if (!['pull_request', 'installation', 'installation_repositories'].includes(event || '')) {
    console.log('Event not tracked');
    return;
  }

  const { action, pull_request, repository, installation, repositories, repositories_added } = payload;

  if (!installation || !installation.id) {
    throw new Error('No GitHub App installation ID found');
  }

  if (event === 'installation' && action === 'created') {
    const senderId = payload.sender.id.toString();
    const account = await prisma.account.findFirst({
      where: { provider: 'github', providerAccountId: senderId },
    });

    if (!account) {
      console.log(`Webhook received installation for unknown user ${senderId}. Awaiting Setup URL redirect linking.`);
      return;
    }

    await prisma.$transaction([
      ...repositories.map((repo: any) =>
        prisma.repository.upsert({
          where: { githubId: BigInt(repo.id) },
          update: { isActive: true },
          create: {
            githubId: BigInt(repo.id),
            fullName: repo.full_name,
            owner: repo.full_name.split('/')[0],
            userId: account.userId,
          }
        })
      ),
      prisma.auditLog.create({
        data: {
          userId: account.userId,
          action: 'Repository Added',
          resource: repositories.map((r: any) => r.full_name).join(', '),
          metadata: { count: repositories.length, event: 'installation' }
        }
      })
    ]);
    console.log(`Successfully installed app and populated ${repositories.length} repositories.`);
    return;
  }

  if (event === 'installation_repositories' && action === 'added') {
    const senderId = payload.sender.id.toString();
    const account = await prisma.account.findFirst({
      where: { provider: 'github', providerAccountId: senderId },
    });

    if (account) {
      await prisma.$transaction([
        ...repositories_added.map((repo: any) =>
          prisma.repository.upsert({
            where: { githubId: BigInt(repo.id) },
            update: { isActive: true },
            create: {
              githubId: BigInt(repo.id),
              fullName: repo.full_name,
              owner: repo.full_name.split('/')[0],
              userId: account.userId,
            }
          })
        ),
        prisma.auditLog.create({
          data: {
            userId: account.userId,
            action: 'Repository Added',
            resource: repositories_added.map((r: any) => r.full_name).join(', '),
            metadata: { count: repositories_added.length, event: 'installation_repositories' }
          }
        })
      ]);
    }
    return;
  }

  if (event === 'pull_request') {
    if (!['opened', 'synchronize', 'reopened'].includes(action)) {
      console.log('Action not tracked');
      return;
    }

    console.log(`Processing PR #${pull_request.number} on ${repository.full_name}`);

    const dbRepo = await prisma.repository.findUnique({
      where: { githubId: BigInt(repository.id) }
    });
    const userId = dbRepo?.userId;

    let activePolicies: any[] = [];
    if (userId) {
      const templates = await prisma.policyTemplate.findMany();
      const userToggles = await prisma.userPolicyToggle.findMany({
        where: { userId }
      });
      
      const toggleMap = new Map(userToggles.map((t: any) => [t.policyTemplateId, t.isActive]));
      
      activePolicies = templates.filter((template: any) => {
        return toggleMap.has(template.id) 
          ? toggleMap.get(template.id) 
          : template.isDefault;
      });
    }

    if (userId) {
      await prisma.auditLog.create({
        data: {
          userId: userId,
          action: 'Scan Triggered',
          resource: `${repository.full_name}#${pull_request.number}`,
          metadata: { action: action, head_sha: pull_request.head.sha }
        }
      });
    }

    const appId = process.env.GITHUB_APP_ID!;
    const privateKey = process.env.GITHUB_PRIVATE_KEY!.replace(/\\n/g, '\n'); 

    const appClient = new App({ appId, privateKey });
    const octokit = await appClient.getInstallationOctokit(installation.id);

    const { data: pullRequestFiles } = await octokit.rest.pulls.listFiles({
      owner: repository.owner.login,
      repo: repository.name,
      pull_number: pull_request.number,
    });

    const fileChanges = pullRequestFiles
      .filter((file: any) => file.patch && file.status !== 'removed')
      .map((file: any) => ({
        filename: file.filename,
        patch: file.patch
      }));

    // Map each changed file to the set of new-file line numbers that are part of
    // the PR diff, so we only anchor inline review comments on commentable lines.
    const commentableLines = new Map<string, Set<number>>();
    for (const file of fileChanges) {
      commentableLines.set(file.filename, getCommentableLines(file.patch));
    }

    const pendingComment = await octokit.rest.issues.createComment({
      owner: repository.owner.login,
      repo: repository.name,
      issue_number: pull_request.number,
      body: `### ⏳ SecureFlow AI Security Scan\n\nEvaluating **${fileChanges.length}** changed files. Please wait while the AI analyzes the code for potential vulnerabilities...`,
    });

    let customIgnores: string[] = [];
    let customPlaceholders: string[] = [];
    try {
      const { data } = await octokit.rest.repos.getContent({
        owner: repository.owner.login,
        repo: repository.name,
        path: '.secureflowignore',
        ref: pull_request.head.sha,
      });
      if (data && 'content' in data && typeof data.content === 'string') {
        const content = Buffer.from(data.content, 'base64').toString('utf8');
        const parsed = parseSecureFlowIgnore(content);
        customIgnores = parsed.ignoredPaths;
        customPlaceholders = parsed.placeholders;
      }
    } catch (e) {
      // Ignored if file does not exist
    }

    const findings = await scanner.scanPullRequest(
      fileChanges,
      activePolicies,
      customIgnores,
      customPlaceholders
    );

    // Attach a stable content fingerprint to every finding so triage decisions
    // can be keyed off it and survive the latest-wins re-scan. When the repo
    // isn't in our DB there's nothing to triage against, so use an empty id.
    findings.forEach((f: any) => {
      f.fingerprint = computeFingerprint(dbRepo?.id ?? '', f.fileLocation, f.type, f.codeSnippet);
    });

    // Fingerprints the user has dismissed (false positive / ignored) for this
    // repo. These must not BLOCK the PR or inflate the risk score, even though
    // the scanner keeps re-detecting them on each push.
    const suppressedFingerprints = new Set<string>();
    if (dbRepo) {
      const dismissed = await prisma.findingTriage.findMany({
        where: {
          repositoryId: dbRepo.id,
          status: { in: ['FALSE_POSITIVE', 'IGNORED'] },
        },
        select: { fingerprint: true },
      });
      dismissed.forEach((t: { fingerprint: string }) => suppressedFingerprints.add(t.fingerprint));
    }

    // Findings that still count toward enforcement — everything the user hasn't
    // dismissed. The full `findings` list is still persisted below (with its
    // fingerprint) so the dashboard can show dismissed items and left-join triage.
    const activeFindings = findings.filter((f: any) => !suppressedFingerprints.has(f.fingerprint));

    const enrichedFindings = await Promise.all(findings.map(async (finding: any) => {
      const aiResponse = await developerReceivesAISecurityExplanations({
        findingType: finding.type,
        severity: finding.severity,
        description: finding.description,
        fileLocation: finding.fileLocation,
        codeSnippet: finding.codeSnippet || ''
      });
      return {
        ...finding,
        explanation: aiResponse.explanation,
        remediation: aiResponse.remediationSuggestions
      };
    }));

    // Evaluate only the findings the user hasn't dismissed, so a triaged-away
    // critical no longer BLOCKs the PR on every subsequent re-scan.
    const decision = iq.evaluateFindings(activeFindings);
    const conclusion = decision === 'PASS' ? 'success' : (decision === 'REVIEW REQUIRED' ? 'action_required' : 'failure');

    if (userId) {
      await prisma.auditLog.create({
        data: {
          userId: userId,
          action: 'Policy Evaluation',
          resource: `${repository.full_name}#${pull_request.number}`,
          decision: decision,
          metadata: {
            findingsCount: activeFindings.length,
            suppressedCount: findings.length - activeFindings.length,
          }
        }
      });
    }

    await octokit.rest.checks.create({
      owner: repository.owner.login,
      repo: repository.name,
      name: 'SecureFlow Scan',
      head_sha: pull_request.head.sha,
      status: 'completed',
      conclusion: conclusion as any,
      output: {
        title: `Policy Decision: ${decision}`,
        summary: `SecureFlow detected ${findings.length} potential security issues.`,
      }
    });

    if (enrichedFindings.length > 0) {
      const severityBadge = (severity: string) =>
        severity === 'CRITICAL' ? '🔴 CRITICAL' : (severity === 'HIGH' ? '🟠 HIGH' : '🟡 MEDIUM');

      // Resolve the diff line to anchor an inline comment on, or null when the
      // finding has no usable line inside the PR diff (GitHub would reject it).
      const anchorLine = (f: any): number | null => {
        if (typeof f.lineStart !== 'number') return null;
        const lines = commentableLines.get(f.fileLocation);
        return lines && lines.has(f.lineStart) ? f.lineStart : null;
      };

      // Findings with a diff-anchored line become inline review comments; the
      // rest fall back into the summary body so nothing is ever lost.
      const inlineComments: { path: string; line: number; body: string }[] = [];
      const summaryFindings: any[] = [];

      enrichedFindings.forEach((f: any) => {
        const line = anchorLine(f);
        if (line !== null) {
          inlineComments.push({
            path: f.fileLocation,
            line,
            body:
              `**${severityBadge(f.severity)} · ${f.type}**\n\n` +
              `${f.explanation}\n\n` +
              `<details>\n<summary><b>🛠️ View Remediation Suggestions</b></summary>\n\n` +
              `${f.remediation}\n\n</details>`,
          });
        } else {
          summaryFindings.push(f);
        }
      });

      const renderSummary = (findingsToRender: any[]) => {
        let body = `### 🛡️ SecureFlow AI Security Report\n\n`;
        body += `⚠️ Detected **${enrichedFindings.length}** potential issues matching your code policies. Please review them before merging.\n\n`;
        if (inlineComments.length > 0 && findingsToRender.length < enrichedFindings.length) {
          body += `📍 **${inlineComments.length}** finding(s) are annotated inline on the exact changed lines below.\n\n`;
        }
        findingsToRender.forEach((f: any) => {
          body += `#### ${severityBadge(f.severity)} | **${f.type}** in \`${f.fileLocation}\`\n`;
          body += `> ${f.explanation}\n\n`;
          body += `<details>\n<summary><b>🛠️ View Remediation Suggestions</b></summary>\n\n`;
          body += `${f.remediation}\n\n`;
          body += `</details>\n\n`;
          body += `---\n\n`;
        });
        return body;
      };

      // Try to post the anchored findings as an inline review. If that fails
      // (e.g. a line slipped past the guard), fall back to a summary comment
      // that contains every finding so a bad line never breaks the webhook.
      let inlinePosted = false;
      if (inlineComments.length > 0) {
        try {
          await octokit.rest.pulls.createReview({
            owner: repository.owner.login,
            repo: repository.name,
            pull_number: pull_request.number,
            commit_id: pull_request.head.sha,
            event: 'COMMENT',
            body: renderSummary(summaryFindings),
            comments: inlineComments,
          });
          inlinePosted = true;
        } catch (err: any) {
          console.error(`[REVIEW] Failed to post inline review comments, falling back to summary comment: ${err.message}`);
        }
      }

      await octokit.rest.issues.updateComment({
        owner: repository.owner.login,
        repo: repository.name,
        comment_id: pendingComment.data.id,
        // When inline posting succeeded, the pending comment only needs the
        // non-anchored findings; otherwise it carries the full report.
        body: renderSummary(inlinePosted ? summaryFindings : enrichedFindings),
      });

      if (userId) {
        await prisma.auditLog.create({
          data: {
            userId: userId,
            action: 'PR Comment Posted',
            resource: `${repository.full_name}#${pull_request.number}`,
            metadata: {
              commentType: 'AI Security Report',
              findingsReported: enrichedFindings.length,
              inlineComments: inlinePosted ? inlineComments.length : 0,
            }
          }
        });
      }
    } else {
      await octokit.rest.issues.updateComment({
        owner: repository.owner.login,
        repo: repository.name,
        comment_id: pendingComment.data.id,
        body: `### 🛡️ SecureFlow AI Security Report\n\n✅ Scan completed successfully. No vulnerabilities found in the **${fileChanges.length}** analyzed files.`,
      });
    }

    if (dbRepo) {
      const dbPr = await prisma.pullRequest.upsert({
        where: { githubId: BigInt(pull_request.id) },
        update: {
          title: pull_request.title,
          state: pull_request.state, 
          status: decision,
        },
        create: {
          githubId: BigInt(pull_request.id),
          prNumber: pull_request.number,
          title: pull_request.title,
          state: pull_request.state,
          status: decision,
          repositoryId: dbRepo.id
        }
      });

      // Risk score ignores dismissed findings so triaged-away issues stop
      // counting toward the stored score (and the risk-trend average).
      const severityScores: Record<string, number> = { CRITICAL: 10, HIGH: 5, MEDIUM: 3, LOW: 1 };
      const riskScore = activeFindings.reduce((score: number, f: any) => score + (severityScores[f.severity.toUpperCase()] || 0), 0);

      await prisma.scanResult.create({
        data: {
          pullRequestId: dbPr.id,
          riskScore,
          policyDecision: decision,
          findings: {
            create: enrichedFindings.map((f: any) => ({
              type: f.type,
              severity: f.severity,
              fileLocation: f.fileLocation,
              lineStart: typeof f.lineStart === 'number' ? f.lineStart : null,
              lineEnd: typeof f.lineEnd === 'number' ? f.lineEnd : null,
              codeSnippet: f.codeSnippet || null,
              explanation: f.explanation || null,
              remediation: f.remediation || null,
              fingerprint: f.fingerprint
            }))
          }
        }
      });
    }

    return;
  }
}, { connection: redis as any });

worker.on('completed', (job) => console.log(`[QUEUE] Job ${job.id} completed.`));
worker.on('failed', async (job, err) => {
  if (!job) return;
  const maxAttempts = job.opts.attempts || 3;
  if (job.attemptsMade >= maxAttempts) {
    console.error(`[DLQ] Job ${job.id} failed permanently after ${job.attemptsMade} attempts: ${err.message}`);
    try {
      await webhookDLQ.add(
        'process-webhook-dlq',
        {
          originalJobId: job.id,
          data: job.data,
          failedReason: err.message,
          failedAt: new Date().toISOString(),
          attemptsMade: job.attemptsMade,
        },
        {
          attempts: 1,
        }
      );
    } catch (dlqErr: any) {
      console.error(`Failed to route job ${job.id} to DLQ:`, dlqErr.message);
    }
  } else {
    console.warn(`[QUEUE] Job ${job.id} failed (attempt ${job.attemptsMade}/${maxAttempts}), retrying with exponential backoff: ${err.message}`);
  }
});
