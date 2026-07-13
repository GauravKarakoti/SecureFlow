import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { createHmac, timingSafeEqual } from 'crypto';
import { scanner, ScanFinding, ScannerTimeoutError } from '@/lib/armor/scanner';
import { iq } from '@/lib/armor/iq';
import { developerReceivesAISecurityExplanations } from '@/ai/flows/developer-receives-ai-security-explanations';
import { App, Octokit } from 'octokit';
import { throttling } from '@octokit/plugin-throttling';
import prisma from '@/lib/prisma';
import { withErrorHandler, AppError } from '@/lib/middleware/error-handler';
import { withRateLimit } from '@/lib/middleware/rateLimit';

function chunkArray<T>(arr: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < arr.length; i += size) {
    chunks.push(arr.slice(i, i + size));
  }
  return chunks;
}

function parseGithubSignature(signatureHeader: string | null): string | null {
  if (!signatureHeader) return null;
  const prefix = 'sha256=';
  return signatureHeader.startsWith(prefix) ? signatureHeader.slice(prefix.length) : null;
}

async function verifyGitHubWebhook(req: NextRequest): Promise<any> {
  const webhookSecret = process.env.GITHUB_WEBHOOK_SECRET;

  if (!webhookSecret) {
    throw new AppError('GITHUB_WEBHOOK_SECRET is not set', 500, false);
  }

  const signatureHex = parseGithubSignature(req.headers.get('x-hub-signature-256'));
  if (!signatureHex) {
    throw new AppError('Missing or invalid x-hub-signature-256 header', 400);
  }

  const payloadText = await req.text();
  const digest = createHmac('sha256', webhookSecret).update(payloadText).digest('hex');

  const sigBuf = Buffer.from(signatureHex, 'hex');
  const digBuf = Buffer.from(digest, 'hex');

  if (sigBuf.length !== digBuf.length || !timingSafeEqual(sigBuf, digBuf)) {
    throw new AppError('Invalid GitHub webhook signature', 401);
  }

  return JSON.parse(payloadText);
}

const handler = withErrorHandler(async function POST(req: NextRequest) {
  let octokitInstance: any = null;
  let checkRunId: number | null = null;
  let repoOwner: string = '';
  let repoName: string = '';
  const rawPayload = await verifyGitHubWebhook(req);

  // Strict input validation schema
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
    sender: z.object({
      id: z.union([z.number(), z.string()])
    }).passthrough().optional()
  }).passthrough();

  const parsed = payloadSchema.safeParse(rawPayload);
  if (!parsed.success) {
    console.error('Invalid webhook payload structure:', parsed.error.format());
    return NextResponse.json({ error: 'Invalid payload structure' }, { status: 400 });
  }
  const payload = parsed.data;

  const deliveryId = req.headers.get('x-github-delivery');
  if (deliveryId) {
    const existingEvent = await prisma.webhookEvent.findUnique({
      where: { deliveryId }
    });
    if (existingEvent) {
      return NextResponse.json({ message: "Webhook already processed" }, { status: 202 });
    }

    // Try to link existing Repository and PullRequest
    const repoGithubId = payload.repository?.id;
    const prGithubId = payload.pull_request?.id;
    let dbRepoId: string | undefined;
    let dbPrId: string | undefined;

    if (repoGithubId) {
      const dbRepo = await prisma.repository.findUnique({
        where: { githubId: BigInt(repoGithubId) }
      });
      if (dbRepo) {
        dbRepoId = dbRepo.id;
      }
    }

    if (prGithubId) {
      const dbPr = await prisma.pullRequest.findUnique({
        where: { githubId: BigInt(prGithubId) }
      });
      if (dbPr) {
        dbPrId = dbPr.id;
      }
    }

    await prisma.webhookEvent.create({
      data: {
        deliveryId,
        repositoryId: dbRepoId,
        pullRequestId: dbPrId,
      }
    });
  }

  const event = req.headers.get('x-github-event');

  // 1. UPDATE: Accept installation events alongside pull requests
  if (!['pull_request', 'installation', 'installation_repositories'].includes(event || '')) {
    return NextResponse.json({ message: 'Event not tracked' }, { status: 200 });
  }

  const { action, pull_request, repository, installation, repositories, repositories_added } = payload;

  if (!installation || !installation.id) {
     return NextResponse.json({ message: 'No GitHub App installation ID found' }, { status: 400 });
  }

  // Record merges so the contribution leaderboard reflects real data:
  // one star is awarded per merged PR (state === "merged"). A merge is a
  // `pull_request` `closed` event with `merged: true`; we only need to flip
  // the stored state, so this skips the full scan pipeline below.
  if (event === 'pull_request' && action === 'closed') {
    const wasMerged = Boolean(pull_request?.merged || pull_request?.merged_at);
    const newState = wasMerged ? 'merged' : 'closed';

    const dbRepo = repository?.id
      ? await prisma.repository.findUnique({ where: { githubId: BigInt(repository.id) } })
      : null;

    if (dbRepo && pull_request) {
      await prisma.pullRequest.upsert({
        where: { githubId: BigInt(pull_request.id) },
        update: {
          state: newState,
          authorLogin: pull_request.user?.login ?? null,
          authorAvatarUrl: pull_request.user?.avatar_url ?? null,
        },
        create: {
          githubId: BigInt(pull_request.id),
          prNumber: pull_request.number,
          title: pull_request.title ?? '',
          state: newState,
          status: 'REVIEW REQUIRED',
          repositoryId: dbRepo.id,
          authorLogin: pull_request.user?.login ?? null,
          authorAvatarUrl: pull_request.user?.avatar_url ?? null,
        },
      });
    }

    return NextResponse.json({ success: true, message: `PR marked ${newState}` });
  }

  if (event === 'installation' && action === 'created') {
    const senderId = payload.sender?.id?.toString() ?? '';
    const account = await prisma.account.findFirst({
      where: { provider: 'github', providerAccountId: senderId },
    });

    if (!account) {
      console.log(`Webhook received installation for unknown user ${senderId}. Awaiting Setup URL redirect linking.`);
      return NextResponse.json({ success: true, message: 'Awaiting user login via setup URL' });
    }

    // Add all selected repositories to the database in chunks of 50 to avoid unscalable transactions
    const repos = repositories || [];
    const chunks = chunkArray(repos, 50);

    for (const chunk of chunks) {
      await prisma.$transaction(
        chunk.map((repo: any) =>
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
        )
      );
    }

    await prisma.auditLog.create({
      data: {
        userId: account.userId,
        action: 'Repository Added',
        resource: repos.map((r: any) => r.full_name).join(', '),
        metadata: { count: repos.length, event: 'installation' }
      }
    });
    console.log(`Successfully installed app and populated ${(repositories || []).length} repositories.`);

    return NextResponse.json({ success: true, message: 'Repositories populated' });
  }

  // ==========================================
  // 3. NEW: Handle Added Repositories post-installation
  // ==========================================
  if (event === 'installation_repositories' && action === 'added') {
    const senderId = payload.sender?.id?.toString() ?? '';
    const account = await prisma.account.findFirst({
      where: { provider: 'github', providerAccountId: senderId },
    });

    if (account) {
      const repos = repositories_added || [];
      const chunks = chunkArray(repos, 50);

      for (const chunk of chunks) {
        await prisma.$transaction(
          chunk.map((repo: any) =>
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
          )
        );
      }

      await prisma.auditLog.create({
        data: {
          userId: account.userId,
          action: 'Repository Added',
          resource: repos.map((r: any) => r.full_name).join(', '),
          metadata: { count: repos.length, event: 'installation_repositories' }
        }
      });
    }
    return NextResponse.json({ success: true, message: 'New repositories added' });
  }

  if (event === 'pull_request') {
    if (!['opened', 'synchronize', 'reopened'].includes(action || '')) {
      return NextResponse.json({ message: 'Action not tracked' }, { status: 200 });
    }

    console.log(`Processing PR #${pull_request?.number ?? 0} on ${repository?.full_name ?? ''}`);

    const dbRepo = await prisma.repository.findUnique({
      where: { githubId: BigInt(repository?.id ?? 0) }
    });
    const userId = dbRepo?.userId;

    // --- NEW: Fetch User's Active Policies ---
    let activePolicies: any[] = [];
    if (userId) {
      // Fetch all templates and the user's specific toggles
      const templates = await prisma.policyTemplate.findMany();
      const userToggles = await prisma.userPolicyToggle.findMany({
        where: { userId }
      });
      
      // Map toggles to efficiently check active status
      const toggleMap = new Map(userToggles.map(t => [t.policyTemplateId, t.isActive]));
      
      // Filter to only include active templates
      activePolicies = templates.filter(template => {
        return toggleMap.has(template.id) 
          ? toggleMap.get(template.id) 
          : template.isDefault;
      });
    }
    // ------------------------------------------

    await prisma.auditLog.create({
      data: {
        userId: userId,
        action: 'Scan Triggered',
        resource: `${repository?.full_name ?? ''}#${pull_request?.number ?? 0}`,
        metadata: { action: action, head_sha: pull_request?.head?.sha ?? '' }
      }
    });

    const appId = process.env.GITHUB_APP_ID!;
    const privateKey = process.env.GITHUB_PRIVATE_KEY!.replace(/\\n/g, '\n'); 

    const ThrottledOctokit = Octokit.plugin(throttling);
    
    const appClient = new App({ 
      appId, 
      privateKey,
      Octokit: ThrottledOctokit.defaults({
        throttle: {
          onRateLimit: (retryAfter: number, options: any) => {
            console.warn(`⚠️ Request quota exhausted for request ${options.method} ${options.url}`);
            if (options.request.retryCount === 0) {
              console.warn(`Retrying after ${retryAfter} seconds!`);
              return true;
            }
          },
          onSecondaryRateLimit: (retryAfter: number, options: any) => {
            console.warn(`⚠️ Secondary rate limit triggered for ${options.method} ${options.url}`);
            if (options.request.retryCount === 0) {
              console.warn(`Retrying after ${retryAfter} seconds!`);
              return true;
            }
          }
        }
      })
    });
    const octokit = await appClient.getInstallationOctokit(Number(installation?.id || 0));
    octokitInstance = octokit;
    repoOwner = repository?.owner?.login ?? '';
    repoName = repository?.name ?? '';

    // Create initial "in_progress" check run
    const checkRun = await octokit.rest.checks.create({
      owner: repoOwner,
      repo: repoName,
      name: 'SecureFlow Scan',
      head_sha: pull_request?.head?.sha ?? '',
      status: 'in_progress',
      started_at: new Date().toISOString(),
    });
    checkRunId = checkRun.data.id;

    let pullRequestFiles;
    try {
      pullRequestFiles = await octokit.paginate(
        octokit.rest.pulls.listFiles,
        {
          owner: repository?.owner?.login ?? '',
          repo: repository?.name ?? '',
          pull_number: pull_request?.number ?? 0,
          per_page: 100,
        }
      );
    } catch (error: any) {
      if (error.status === 403 || error.status === 429 || (error.message && error.message.toLowerCase().includes('rate limit'))) {
        console.error('GitHub API rate limit exceeded while fetching PR files:', error);
        
        await octokit.rest.checks.update({
          owner: repoOwner,
          repo: repoName,
          check_run_id: checkRunId!,
          status: 'completed',
          conclusion: 'failure',
          completed_at: new Date().toISOString(),
          output: {
            title: `Scan Failed: API Rate Limit`,
            summary: `Scan failed due to GitHub API rate limits. Please try again later.`,
          }
        });
        
        return NextResponse.json({ success: false, message: 'Rate limit exceeded, check run updated to failure' }, { status: 202 });
      }
      throw error;
    }

    const MAX_FILES_PER_SCAN = 150;
    let fileChanges = pullRequestFiles
      .filter((file: any) => file.patch && file.status !== 'removed') 
      .map((file: any) => ({
        filename: file.filename,
        patch: file.patch
      }));

    let warningMessage = '';
    if (fileChanges.length > MAX_FILES_PER_SCAN) {
      fileChanges = fileChanges.slice(0, MAX_FILES_PER_SCAN);
      warningMessage = `\n\n⚠️ **Warning:** This PR exceeds the maximum size limit. Only the first ${MAX_FILES_PER_SCAN} files were scanned to prevent timeout and rate-limit exhaustion.`;
    }

    const pendingComment = await octokit.rest.issues.createComment({
      owner: repository?.owner?.login ?? '',
      repo: repository?.name ?? '',
      issue_number: pull_request?.number ?? 0,
      body: `### ⏳ SecureFlow AI Security Scan\n\nEvaluating **${fileChanges.length}** changed files. Please wait while the AI analyzes the code for potential vulnerabilities...${warningMessage}`,
    });

    // Fetch custom ignore patterns from .secureflowignore if it exists in the root of the repository
    let customIgnores: string[] = [];
    try {
      const { data: ignoreFile } = await octokit.rest.repos.getContent({
        owner: repoOwner,
        repo: repoName,
        path: '.secureflowignore',
        ref: pull_request?.head?.sha ?? '',
      });

      if (!Array.isArray(ignoreFile) && ignoreFile.type === 'file' && ignoreFile.content) {
        const rawContent = Buffer.from(ignoreFile.content, 'base64').toString('utf8');
        customIgnores = rawContent
          .split(/\r?\n/)
          .map(line => line.trim())
          .filter(line => line.length > 0 && !line.startsWith('#'));
        console.log(`ℹ️ Found .secureflowignore with ${customIgnores.length} custom ignore patterns.`);
      }
    } catch (error: any) {
      if (error.status === 404) {
        console.log('ℹ️ No .secureflowignore file found in repository root.');
      } else {
        console.warn('⚠️ Error fetching .secureflowignore:', error.message || error);
      }
    }

    // --- UPDATE: Pass the active policies to the scanner with graceful AI fallbacks ---
    try {
      const findings: ScanFinding[] = await scanner.scanPullRequest(fileChanges, activePolicies, customIgnores);

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
          promptInjectionSuspected: aiResponse.promptInjectionSuspected
        };
      }));

      const decision = iq.evaluateFindings(findings);
      const conclusion = decision === 'PASS' ? 'success' : (decision === 'REVIEW REQUIRED' ? 'action_required' : 'failure');
      
      // --- EVENT 3: Policy Evaluation ---
      await prisma.auditLog.create({
        data: {
          userId: userId,
          action: 'Policy Evaluation',
          resource: `${repository?.full_name ?? ''}#${pull_request?.number ?? 0}`,
          decision: decision,
          metadata: { findingsCount: findings.length }
        }
      });
      // ----------------------------------

      await octokit.rest.checks.update({
        owner: repoOwner,
        repo: repoName,
        check_run_id: checkRunId!,
        status: 'completed',
        conclusion: conclusion,
        completed_at: new Date().toISOString(),
        output: {
          title: `Policy Decision: ${decision}`,
          summary: `SecureFlow detected ${findings.length} potential security issues.`,
        }
      });

      if (enrichedFindings.length > 0) {
        let commentBody = `### 🛡️ SecureFlow AI Security Report\n\n`;
        if (warningMessage) commentBody += `${warningMessage}\n\n`;
        commentBody += `⚠️ Detected **${enrichedFindings.length}** potential issues matching your code policies. Please review them before merging.\n\n`;

        enrichedFindings.forEach((f: any) => {
          // Determine color indicator badge based on severity
          const badge = f.severity === 'CRITICAL' ? '🔴 CRITICAL' : (f.severity === 'HIGH' ? '🟠 HIGH' : '🟡 MEDIUM');
          
          commentBody += `#### ${badge} | **${f.type}** in \`${f.fileLocation}\`\n`;
          if (f.promptInjectionSuspected) {
            commentBody += `⚠️ **AI explanation may be unreliable for this finding — verify manually.** The scanned code may contain content crafted to influence the AI narrative below. The severity badge above comes from the static scanner and is unaffected.\n\n`;
          }
          commentBody += `> ${f.explanation}\n\n`;
          
          // Use collapsible HTML blocks so remediation details don't drown out the screen real estate
          commentBody += `<details>\n<summary><b>🛠️ View Remediation Suggestions</b></summary>\n\n`;
          commentBody += `${f.remediation}\n\n`;
          commentBody += `</details>\n\n`;
          commentBody += `---\n\n`;
        });

        // Update the comment we created earlier
        await octokit.rest.issues.updateComment({
          owner: repository?.owner?.login ?? '',
          repo: repository?.name ?? '',
          comment_id: pendingComment.data.id,
          body: commentBody,
        });

        // --- EVENT 4: PR Comment Posted ---
        await prisma.auditLog.create({
          data: {
            userId: userId,
            action: 'PR Comment Posted',
            resource: `${repository?.full_name ?? ''}#${pull_request?.number ?? 0}`,
            metadata: { commentType: 'AI Security Report', findingsReported: enrichedFindings.length }
          }
        });
      } else {
        // If no findings, update the comment to show success!
        await octokit.rest.issues.updateComment({
          owner: repository?.owner?.login ?? '',
          repo: repository?.name ?? '',
          comment_id: pendingComment.data.id,
          body: `### 🛡️ SecureFlow AI Security Report\n\n✅ Scan completed successfully. No vulnerabilities found in the **${fileChanges.length}** analyzed files.${warningMessage}`,
        });
      }

      // Persist PR details to DB
      if (dbRepo) {
        const dbPr = await prisma.pullRequest.upsert({
          where: { githubId: BigInt(pull_request?.id ?? 0) },
          update: {
            title: pull_request?.title ?? '',
            state: pull_request?.state ?? '', 
            status: decision,
            authorLogin: pull_request?.user?.login ?? null,
            authorAvatarUrl: pull_request?.user?.avatar_url ?? null,
          },
          create: {
            githubId: BigInt(pull_request?.id ?? 0),
            prNumber: pull_request?.number ?? 0,
            title: pull_request?.title ?? '',
            state: pull_request?.state ?? '',
            status: decision,
            repositoryId: dbRepo.id,
            authorLogin: pull_request?.user?.login ?? null,
            authorAvatarUrl: pull_request?.user?.avatar_url ?? null,
          }
        });

        // Update WebhookEvent to link it to the newly created/upserted PullRequest
        if (deliveryId) {
          await prisma.webhookEvent.update({
            where: { deliveryId },
            data: {
              repositoryId: dbRepo.id,
              pullRequestId: dbPr.id,
            }
          });
        }

        const severityScores: Record<string, number> = { CRITICAL: 10, HIGH: 5, MEDIUM: 3, LOW: 1 };
        const riskScore = findings.reduce((score: number, f: any) => score + (severityScores[f.severity.toUpperCase()] || 0), 0);

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
                codeSnippet: f.codeSnippet || null,
                explanation: f.explanation || null,
                remediation: f.remediation || null,
                promptInjectionSuspected: f.promptInjectionSuspected || false
              }))
            }
          }
        });
      }

      return NextResponse.json({ success: true, decision, findingCount: findings.length });
    } catch (err: any) {
      console.error('Scan failed or timed out:', err);

      await octokit.rest.checks.update({
        owner: repoOwner,
        repo: repoName,
        check_run_id: checkRunId!,
        status: 'completed',
        conclusion: 'neutral',
        completed_at: new Date().toISOString(),
        output: {
          title: `Scan Error`,
          summary: `The automated security scan could not be completed.`,
        }
      });

      await prisma.auditLog.create({
        data: {
          userId: userId,
          action: 'Scan Failed',
          resource: `${repository?.full_name ?? ''}#${pull_request?.number ?? 0}`,
          decision: 'FAIL',
          metadata: { error: err.message || String(err), status: 'TIMEOUT_OR_FAILURE' }
        }
      });

      await octokit.rest.issues.updateComment({
        owner: repository?.owner?.login ?? '',
        repo: repository?.name ?? '',
        comment_id: pendingComment.data.id,
        body: `### 🛡️ SecureFlow AI Security Report\n\n⚠️ **Scan Failed:** The automated security scan could not be completed due to an AI timeout or API error. The PR is unblocked, but manual review is advised.\n\n_Error details: ${err.message || String(err)}_`,
      });

      return NextResponse.json({ success: false, error: err.message || String(err), fallback: true });
    }
  }

  return NextResponse.json({ message: 'Event successfully caught but ignored' }, { status: 200 });
});

export const POST = withRateLimit(handler, { limit: 50, windowSeconds: 60, keyPrefix: 'webhook:github' });