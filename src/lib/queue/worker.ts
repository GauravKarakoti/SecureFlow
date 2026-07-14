import { Worker, Job } from 'bullmq';
import { redis } from './redis';
import { scanner } from '@/lib/armor/scanner';
import { iq } from '@/lib/armor/iq';
import { developerReceivesAISecurityExplanations } from '@/ai/flows/developer-receives-ai-security-explanations';
import { App } from 'octokit';
import prisma from '@/lib/prisma';

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
      
      const toggleMap = new Map(userToggles.map(t => [t.policyTemplateId, t.isActive]));
      
      activePolicies = templates.filter(template => {
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

    const pendingComment = await octokit.rest.issues.createComment({
      owner: repository.owner.login,
      repo: repository.name,
      issue_number: pull_request.number,
      body: `### ⏳ SecureFlow AI Security Scan\n\nEvaluating **${fileChanges.length}** changed files. Please wait while the AI analyzes the code for potential vulnerabilities...`,
    });

    const findings = await scanner.scanPullRequest(fileChanges, activePolicies);
    
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

    const decision = iq.evaluateFindings(findings);
    const conclusion = decision === 'PASS' ? 'success' : (decision === 'REVIEW REQUIRED' ? 'action_required' : 'failure');
    
    if (userId) {
      await prisma.auditLog.create({
        data: {
          userId: userId,
          action: 'Policy Evaluation',
          resource: `${repository.full_name}#${pull_request.number}`,
          decision: decision,
          metadata: { findingsCount: findings.length }
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
      let commentBody = `### 🛡️ SecureFlow AI Security Report\n\n`;
      commentBody += `⚠️ Detected **${enrichedFindings.length}** potential issues matching your code policies. Please review them before merging.\n\n`;

      enrichedFindings.forEach((f: any) => {
        const badge = f.severity === 'CRITICAL' ? '🔴 CRITICAL' : (f.severity === 'HIGH' ? '🟠 HIGH' : '🟡 MEDIUM');
        
        commentBody += `#### ${badge} | **${f.type}** in \`${f.fileLocation}\`\n`;
        commentBody += `> ${f.explanation}\n\n`;
        
        commentBody += `<details>\n<summary><b>🛠️ View Remediation Suggestions</b></summary>\n\n`;
        commentBody += `${f.remediation}\n\n`;
        commentBody += `</details>\n\n`;
        commentBody += `---\n\n`;
      });

      await octokit.rest.issues.updateComment({
        owner: repository.owner.login,
        repo: repository.name,
        comment_id: pendingComment.data.id,
        body: commentBody,
      });

      if (userId) {
        await prisma.auditLog.create({
          data: {
            userId: userId,
            action: 'PR Comment Posted',
            resource: `${repository.full_name}#${pull_request.number}`,
            metadata: { commentType: 'AI Security Report', findingsReported: enrichedFindings.length }
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
              remediation: f.remediation || null
            }))
          }
        }
      });
    }

    return;
  }
}, { connection: redis as any });

worker.on('completed', (job) => console.log(`[QUEUE] Job ${job.id} completed.`));
worker.on('failed', (job, err) => console.error(`[DLQ] Job ${job?.id} failed permanently: ${err.message}`));
