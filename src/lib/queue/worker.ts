import { Worker, Job } from 'bullmq';
import { z } from 'zod';
import { redis } from './redis';
import { webhookDLQ, WebhookJobData } from './webhookQueue';
import { scanner, parseSecureFlowIgnore } from '@/lib/armor/scanner';
import { iq } from '@/lib/armor/iq';
import { computeFingerprint } from '@/lib/armor/fingerprint';
import { developerReceivesAISecurityExplanations } from '@/ai/flows/developer-receives-ai-security-explanations';
import { App } from 'octokit';
import { fetchPullRequestFiles, formatCoverageNotice } from '@/lib/github/pull-request-files';
import prisma from '@/lib/prisma';
import { sanitizeAuditLogInput } from '@/lib/audit/minimization';
import { normalizeSeverity, severityBadge, totalRiskScore } from '@/lib/severity';

// Sanitize user-controlled strings before logging to prevent log injection (CWE-117)
const sanitize = (s: unknown) => String(s ?? '').replace(/[\r\n]/g, ' ');

// 1. Strict input validation schemas
const repoSchema = z.object({
  id: z.union([z.number(), z.string()]),
  full_name: z.string(),
  name: z.string().optional(),
  owner: z.object({
    login: z.string()
  }).passthrough().optional()
}).passthrough();

const payloadSchema = z.object({
  action: z.string().optional(),
  pull_request: z.object({
    id: z.union([z.number(), z.string()]),
    number: z.number(),
    title: z.string().optional(),
    state: z.string().optional(),
    merged: z.boolean().optional(),
    merged_at: z.string().nullable().optional(),
    head: z.object({
      sha: z.string()
    }).passthrough().optional(),
    user: z.object({
      login: z.string(),
      avatar_url: z.string().optional()
    }).passthrough().optional()
  }).passthrough().optional(),
  repository: repoSchema.optional(),
  installation: z.object({
    id: z.union([z.number(), z.string()])
  }).passthrough().optional(),
  repositories: z.array(repoSchema).optional(),
  repositories_added: z.array(repoSchema).optional(),
  // Present on `installation_repositories` deliveries with action 'removed'.
  // Previously absent from the schema entirely, which is part of why that
  // action fell through to code expecting `repositories_added`.
  repositories_removed: z.array(repoSchema).optional(),
  sender: z.object({
    id: z.union([z.number(), z.string()])
  }).passthrough().optional()
}).passthrough();

/** Cap on how much of a Zod error is embedded in a thrown message. */
export const MAX_VALIDATION_ERROR_LENGTH = 500;

/**
 * Trim `text` so a failure reason stays a reasonable size.
 *
 * The formatted Zod error for a large webhook payload can run to many kilobytes,
 * and BullMQ writes the failure reason into Redis on every failed attempt.
 */
export function truncateForError(text: string, maxLength: number = MAX_VALIDATION_ERROR_LENGTH): string {
  if (text.length <= maxLength) return text;
  return `${text.slice(0, maxLength)}… (truncated, ${text.length} chars total)`;
}

/**
 * A problem with the deployment itself rather than with the delivery.
 *
 * Retrying cannot help — the same missing variable will still be missing — so
 * this is thrown with a message that names the variable instead of surfacing as
 * a confusing dereference error three attempts later.
 */
export class WebhookConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WebhookConfigurationError';
  }
}

/**
 * Read and validate the GitHub App credentials.
 *
 * The previous `process.env.GITHUB_PRIVATE_KEY!.replace(...)` produced
 * "Cannot read properties of undefined (reading 'replace')" when the variable
 * was unset — a misleading error for a straightforward misconfiguration.
 */
export function getGitHubAppCredentials(
  env: NodeJS.ProcessEnv | Record<string, string | undefined> = process.env
): { appId: string; privateKey: string } {
  const appId = env.GITHUB_APP_ID?.trim();
  const rawPrivateKey = env.GITHUB_PRIVATE_KEY;

  if (!appId) {
    throw new WebhookConfigurationError('GITHUB_APP_ID is not set; cannot authenticate as the GitHub App.');
  }
  if (!rawPrivateKey || rawPrivateKey.trim() === '') {
    throw new WebhookConfigurationError('GITHUB_PRIVATE_KEY is not set; cannot authenticate as the GitHub App.');
  }

  // Keys are commonly stored with literal "\n" sequences in a single-line env var.
  return { appId, privateKey: rawPrivateKey.replace(/\\n/g, '\n') };
}

export interface RepoLike {
  id: number | string;
  full_name: string;
  [key: string]: unknown;
}

export type RepositoryListIntent = 'add' | 'remove' | 'ignore';

export interface RepositoryListSelection {
  intent: RepositoryListIntent;
  repositories: RepoLike[];
}

/**
 * Work out which repository list an installation-flavoured delivery carries.
 *
 * GitHub does not always send the field the old code assumed:
 *  - `installation` / 'created' normally carries `repositories`, but omits it in
 *    some selected-repository flows;
 *  - `installation_repositories` / 'added' carries `repositories_added`;
 *  - `installation_repositories` / 'removed' carries `repositories_removed`,
 *    which the old code did not handle at all.
 *
 * Returning an empty list rather than throwing means a delivery with nothing to
 * do is a no-op, not three retries and a DLQ entry.
 */
export function selectRepositoryList(
  event: string | null | undefined,
  action: string | null | undefined,
  payload: {
    repositories?: unknown;
    repositories_added?: unknown;
    repositories_removed?: unknown;
  }
): RepositoryListSelection {
  const asList = (value: unknown): RepoLike[] =>
    Array.isArray(value)
      ? (value.filter(
          (r) => r && typeof r === 'object' && 'id' in r && 'full_name' in r
        ) as RepoLike[])
      : [];

  if (event === 'installation' && action === 'created') {
    return { intent: 'add', repositories: asList(payload.repositories) };
  }

  if (event === 'installation_repositories') {
    if (action === 'added') {
      return { intent: 'add', repositories: asList(payload.repositories_added) };
    }
    if (action === 'removed') {
      return { intent: 'remove', repositories: asList(payload.repositories_removed) };
    }
  }

  return { intent: 'ignore', repositories: [] };
}

export interface PullRequestContext {
  pullRequest: Record<string, any>;
  repository: Record<string, any>;
  ownerLogin: string;
  repoName: string;
  headSha: string;
  prNumber: number;
}

/**
 * Assert that a `pull_request` delivery carries everything the handler needs.
 *
 * Every one of these fields is `.optional()` in the schema, so a partial payload
 * used to validate cleanly and then throw deep inside the handler — after the
 * pending PR comment had already been posted, leaving a permanent
 * "⏳ Evaluating..." comment that nothing ever updated.
 */
export function assertPullRequestContext(payload: {
  pull_request?: any;
  repository?: any;
}): PullRequestContext {
  const missing: string[] = [];

  const pullRequest = payload.pull_request;
  const repository = payload.repository;

  if (!pullRequest) missing.push('pull_request');
  if (!repository) missing.push('repository');

  const prNumber = pullRequest?.number;
  if (typeof prNumber !== 'number') missing.push('pull_request.number');

  const headSha = pullRequest?.head?.sha;
  if (typeof headSha !== 'string' || headSha === '') missing.push('pull_request.head.sha');

  // `name` is optional in the schema but always derivable from `full_name`.
  const repoName =
    typeof repository?.name === 'string' && repository.name !== ''
      ? repository.name
      : typeof repository?.full_name === 'string'
        ? repository.full_name.split('/')[1]
        : undefined;
  if (!repoName) missing.push('repository.name');

  const ownerLogin =
    typeof repository?.owner?.login === 'string' && repository.owner.login !== ''
      ? repository.owner.login
      : typeof repository?.full_name === 'string'
        ? repository.full_name.split('/')[0]
        : undefined;
  if (!ownerLogin) missing.push('repository.owner.login');

  if (missing.length > 0) {
    throw new Error(`Incomplete pull_request payload; missing: ${missing.join(', ')}`);
  }

  return {
    pullRequest,
    repository,
    ownerLogin: ownerLogin as string,
    repoName: repoName as string,
    headSha: headSha as string,
    prNumber: prNumber as number,
  };
}


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

export const worker = new Worker<WebhookJobData>('github-webhooks', async (job: Job<WebhookJobData>) => {
  const { payload: rawPayload, event, deliveryId } = job.data;

  // Event Filtering
  if (!['pull_request', 'installation', 'installation_repositories'].includes(event || '')) {
    console.log(`Event not tracked: ${sanitize(event)}`);
    return;
  }

  // 2. Validate Payload
  const parsed = payloadSchema.safeParse(rawPayload);
  if (!parsed.success) {
    throw new Error(
      `Invalid payload structure: ${truncateForError(JSON.stringify(parsed.error.format()))}`
    );
  }
  const payload = parsed.data;

  // 3. Check Idempotency FIRST (Do not write until job completes)
  if (deliveryId) {
    const existingEvent = await prisma.webhookEvent.findUnique({
      where: { deliveryId }
    });
    
    if (existingEvent) {
      console.log(`[Worker] Webhook ${sanitize(deliveryId)} already processed. Skipping.`);
      return;
    }
  }

  // Destructure validated payload properties for processing
  const { action, pull_request, repository, installation } = payload as any;

  // Resolved once here so every installation-flavoured branch reads the same
  // field, including the 'removed' action the old code never handled.
  const repoSelection = selectRepositoryList(event, action, payload as any);

  if (!installation || !installation.id) {
    throw new Error('No GitHub App installation ID found');
  }

  // Extract metadata for the idempotency lock
  let dbRepoId: string | undefined;
  let dbPrId: string | undefined;

  if (repository?.id) {
    const dbRepo = await prisma.repository.findUnique({
      where: { githubId: BigInt(repository.id) }
    });
    if (dbRepo) dbRepoId = dbRepo.id;
  }

  if (pull_request?.id) {
    const dbPr = await prisma.pullRequest.findUnique({
      where: { githubId: BigInt(pull_request.id) }
    });
    if (dbPr) dbPrId = dbPr.id;
  }

  // === EXECUTION PHASE ===
  if (event === 'installation' && action === 'created') {
    const senderId = payload.sender?.id?.toString();
    const account = await prisma.account.findFirst({
      where: { provider: 'github', providerAccountId: senderId },
    });

    if (!account) {
      console.log(`Webhook received installation for unknown user ${sanitize(senderId)}. Awaiting Setup URL redirect linking.`);
      return; // Safe to return early here; user hasn't set up yet so we shouldn't lock the webhook.
    }

    // GitHub omits `repositories` from some selected-repository install flows.
    // The old code called .map() on it unconditionally and threw a TypeError,
    // burning three retries before landing a valid delivery in the DLQ.
    if (repoSelection.repositories.length === 0) {
      console.log('[Worker] Installation delivery carried no repositories; nothing to link.');
    } else {
      await prisma.$transaction([
        ...repoSelection.repositories.map((repo) =>
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
          data: sanitizeAuditLogInput({
            userId: account.userId,
            action: 'Repository Added',
            resource: repoSelection.repositories.map((r) => r.full_name).join(', '),
            metadata: { count: repoSelection.repositories.length, event: 'installation' }
          })
        })
      ]);
      console.log(`Successfully installed app and populated ${repoSelection.repositories.length} repositories.`);
    }

  } else if (event === 'installation_repositories' && (action === 'added' || action === 'removed')) {
    const senderId = payload.sender?.id?.toString();
    const account = await prisma.account.findFirst({
      where: { provider: 'github', providerAccountId: senderId },
    });

    if (!account) {
      console.log(`[Worker] installation_repositories for unknown user ${sanitize(senderId)}; skipping.`);
    } else if (repoSelection.repositories.length === 0) {
      console.log(`[Worker] installation_repositories '${sanitize(action)}' carried no repositories; nothing to do.`);
    } else if (repoSelection.intent === 'remove') {
      // 'removed' deliveries were previously routed into the 'added' branch's
      // shape and threw on the missing `repositories_added` field. Repositories
      // are deactivated rather than deleted so their scan history survives.
      await prisma.$transaction([
        prisma.repository.updateMany({
          where: { githubId: { in: repoSelection.repositories.map((r) => BigInt(r.id)) } },
          data: { isActive: false },
        }),
        prisma.auditLog.create({
          data: sanitizeAuditLogInput({
            userId: account.userId,
            action: 'Repository Removed',
            resource: repoSelection.repositories.map((r) => r.full_name).join(', '),
            metadata: { count: repoSelection.repositories.length, event: 'installation_repositories' }
          })
        })
      ]);
    } else {
      await prisma.$transaction([
        ...repoSelection.repositories.map((repo) =>
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
          data: sanitizeAuditLogInput({
            userId: account.userId,
            action: 'Repository Added',
            resource: repoSelection.repositories.map((r) => r.full_name).join(', '),
            metadata: { count: repoSelection.repositories.length, event: 'installation_repositories' }
          })
        })
      ]);
    }

  } else if (event === 'pull_request') {
    if (!['opened', 'synchronize', 'reopened'].includes(action)) {
      console.log('Action not tracked');
    } else {
      // Fail fast on an incomplete payload. Every field used below is
      // `.optional()` in the schema, so a partial delivery used to validate
      // cleanly and then throw after the pending PR comment had been posted —
      // leaving a permanent "⏳ Evaluating..." comment nothing ever updated.
      assertPullRequestContext(payload as any);

      console.log(`Processing PR #${sanitize(pull_request.number)} on ${sanitize(repository.full_name)}`);

      let dbRepo = await prisma.repository.findUnique({
        where: { githubId: BigInt(repository.id) }
      });

      // FIX: Lazy-link the repository if it was missed during the initial installation
      if (!dbRepo) {
        const senderId = payload.sender?.id?.toString();
        const account = await prisma.account.findFirst({
          where: { provider: 'github', providerAccountId: senderId },
        });

        if (account) {
          dbRepo = await prisma.repository.create({
            data: {
              githubId: BigInt(repository.id),
              fullName: repository.full_name,
              owner: repository.owner.login,
              userId: account.userId,
              isActive: true
            }
          });
          console.log(`[Worker] Lazy-linked missing repository ${sanitize(repository.full_name)} to user ${sanitize(account.userId)}`);
        }
      }

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
          data: sanitizeAuditLogInput({
            userId: userId,
            action: 'Scan Triggered',
            resource: `${repository.full_name}#${pull_request.number}`,
            metadata: { action: action, head_sha: pull_request.head.sha }
          })
        });
      }

      const { appId, privateKey } = getGitHubAppCredentials();

      const appClient = new App({ appId, privateKey });
      const octokit = await appClient.getInstallationOctokit(installation.id);

      // Paginated: the endpoint defaults to 30 files per page, so an unpaginated
      // call left every file past the 30th unscanned while still reporting a
      // policy decision as though the whole PR had been reviewed.
      const pullRequestFilesResult = await fetchPullRequestFiles(octokit as any, {
        owner: repository.owner.login,
        repo: repository.name,
        pullNumber: pull_request.number,
        changedFiles: typeof pull_request.changed_files === 'number' ? pull_request.changed_files : null,
      });

      const coverageNotice = formatCoverageNotice(pullRequestFilesResult);
      if (coverageNotice) {
        console.warn(
          `[Worker] Partial file coverage on ${sanitize(repository.full_name)}#${sanitize(pull_request.number)}: analysed ${sanitize(pullRequestFilesResult.fetched)} of ${sanitize(pullRequestFilesResult.totalChanged ?? 'unknown')} changed files.`
        );
      }

      const fileChanges = pullRequestFilesResult.files
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
        body:
          `### ⏳ SecureFlow AI Security Scan\n\nEvaluating **${fileChanges.length}** changed files. Please wait while the AI analyzes the code for potential vulnerabilities...` +
          (coverageNotice ? `\n\n${coverageNotice}` : ''),
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

      console.log(`[DEBUG] Passing ${sanitize(activePolicies.length)} active policies to scanner.`);
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
          remediation: aiResponse.remediationSuggestions,
          // Layer 4 (UI surfacing): carry the injection flag through to the PR comment
          // and dashboard so reviewers are warned when the AI narrative may be unreliable.
          promptInjectionSuspected: aiResponse.promptInjectionSuspected,
        };
      }));

      // Evaluate only the findings the user hasn't dismissed, so a triaged-away
      // critical no longer BLOCKs the PR on every subsequent re-scan.
      const decision = iq.evaluateFindings(activeFindings);
      const conclusion = decision === 'PASS' ? 'success' : (decision === 'REVIEW REQUIRED' ? 'action_required' : 'failure');

      if (userId) {
        await prisma.auditLog.create({
          data: sanitizeAuditLogInput({
            userId: userId,
            action: 'Policy Evaluation',
            resource: `${repository.full_name}#${pull_request.number}`,
            decision: decision,
            metadata: {
              findingsCount: activeFindings.length,
              suppressedCount: findings.length - activeFindings.length,
            }
          })
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
          // The scanned-file count is stated explicitly so a truncated scan can
          // never read as a clean bill of health for the whole PR.
          summary:
            `SecureFlow detected ${findings.length} potential security issues across ${fileChanges.length} analyzed file(s).` +
            (coverageNotice ? `\n\n${coverageNotice}` : ''),
        }
      });

      if (enrichedFindings.length > 0) {
        // Badge rendering comes from `@/lib/severity`. The previous inline
        // ternary only special-cased CRITICAL and HIGH, so LOW and NONE findings
        // were both labelled "🟡 MEDIUM" in the pull request comment — the report
        // overstated the severity of the least severe findings.

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
                // Layer 4: surface injection warning on the individual inline comment when flagged.
                (f.promptInjectionSuspected
                  ? `> ⚠️ **AI explanation may be unreliable for this finding — verify manually.** The code snippet associated with this finding triggered prompt-injection heuristics or produced a severity-inconsistent response. Trust the ${severityBadge(f.severity)} badge from the static scanner above the AI narrative.\n\n`
                  : '') +
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
          if (coverageNotice) {
            body += `${coverageNotice}\n\n`;
          }
          if (inlineComments.length > 0 && findingsToRender.length < enrichedFindings.length) {
            body += `📍 **${inlineComments.length}** finding(s) are annotated inline on the exact changed lines below.\n\n`;
          }
          findingsToRender.forEach((f: any) => {
            body += `#### ${severityBadge(f.severity)} | **${f.type}** in \`${f.fileLocation}\`\n`;
            // Layer 4: surface injection warning in the summary body when the flag is set.
            if (f.promptInjectionSuspected) {
              body += `> ⚠️ **AI explanation may be unreliable for this finding — verify manually.** The code snippet triggered prompt-injection heuristics or produced a severity-inconsistent response. Trust the ${severityBadge(f.severity)} badge from the static scanner above the AI narrative.\n\n`;
            }
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
            console.error(`[REVIEW] Failed to post inline review comments, falling back to summary comment: ${sanitize(err.message)}`);
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
            data: sanitizeAuditLogInput({
              userId: userId,
              action: 'PR Comment Posted',
              resource: `${repository.full_name}#${pull_request.number}`,
              metadata: {
                commentType: 'AI Security Report',
                findingsReported: enrichedFindings.length,
                inlineComments: inlinePosted ? inlineComments.length : 0,
              }
            })
          });
        }
      } else {
        await octokit.rest.issues.updateComment({
          owner: repository.owner.login,
          repo: repository.name,
          comment_id: pendingComment.data.id,
          body:
            `### 🛡️ SecureFlow AI Security Report\n\n✅ Scan completed successfully. No vulnerabilities found in the **${fileChanges.length}** analyzed files.` +
            // A clean result on a partial scan must say so — this is exactly the
            // case where silent truncation was most misleading.
            (coverageNotice ? `\n\n${coverageNotice}` : ''),
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

        dbPrId = dbPr.id; // Capture the DB ID for the lock record

        // Risk score ignores dismissed findings so triaged-away issues stop
        // counting toward the stored score (and the risk-trend average).
        //
        // The weights live in `@/lib/severity` now. The previous inline reducer
        // called `f.severity.toUpperCase()` directly, which threw a TypeError on
        // a null severity — after the pending "⏳ Evaluating..." comment had
        // already been posted, so the job retried three times, landed in the DLQ,
        // and left the comment stranded on the pull request forever.
        const riskScore = totalRiskScore(activeFindings as Array<{ severity: unknown }>);

        await prisma.scanResult.create({
          data: {
            pullRequestId: dbPr.id,
            riskScore,
            policyDecision: decision,
            findings: {
              create: enrichedFindings.map((f: any) => ({
                type: f.type,
                // Persist the canonical spelling. `Finding.severity` is an
                // unconstrained `String` column, so without this a non-canonical
                // value written once stays wrong for every later read — the
                // dashboard, the policy engine and the risk trend all re-derive
                // from this column.
                severity: normalizeSeverity(f.severity),
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
    }
  }

  // 4. LOCK: Mark the webhook as processed now that everything succeeded
  if (deliveryId) {
    await prisma.webhookEvent.create({
      data: {
        deliveryId,
        repositoryId: dbRepoId,
        pullRequestId: dbPrId,
      }
    });
    console.log(`[Worker] Successfully processed and cached webhook ${sanitize(deliveryId)}`);
  }
}, { connection: redis as any });

worker.on('completed', (job: Job) => console.log(`[QUEUE] Job ${job.id} completed.`));
worker.on('failed', async (job: Job | undefined, err: Error) => {
  if (!job) return;
  const maxAttempts = job.opts.attempts || 3;
  if (job.attemptsMade >= maxAttempts) {
    console.error(`[DLQ] Job ${sanitize(job.id)} failed permanently after ${sanitize(job.attemptsMade)} attempts: ${sanitize(err.message)}`);
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
      console.error(`Failed to route job ${sanitize(job.id)} to DLQ:`, sanitize(dlqErr.message));
    }
  } else {
    console.warn(`[QUEUE] Job ${sanitize(job.id)} failed (attempt ${sanitize(job.attemptsMade)}/${sanitize(maxAttempts)}), retrying with exponential backoff: ${sanitize(err.message)}`);
  }
});