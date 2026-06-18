import { NextRequest, NextResponse } from 'next/server';
import { claw } from '@/lib/armor/claw';
import { iq } from '@/lib/armor/iq';
import { developerReceivesAISecurityExplanations } from '@/ai/flows/developer-receives-ai-security-explanations';
import { App } from 'octokit';
import prisma from '@/lib/prisma'; 

export async function POST(req: NextRequest) {
  try {
    const payload = await req.json();
    const event = req.headers.get('x-github-event');

    // 1. UPDATE: Accept installation events alongside pull requests
    if (!['pull_request', 'installation', 'installation_repositories'].includes(event || '')) {
      return NextResponse.json({ message: 'Event not tracked' }, { status: 200 });
    }

    const { action, pull_request, repository, installation, repositories, repositories_added } = payload;

    if (!installation || !installation.id) {
       return NextResponse.json({ message: 'No GitHub App installation ID found' }, { status: 400 });
    }

    if (event === 'installation' && action === 'created') {
      const senderId = payload.sender.id.toString();
      const account = await prisma.account.findFirst({
        where: { provider: 'github', providerAccountId: senderId },
      });

      // If the account exists, process it in the background.
      // If it doesn't, return 200 OK anyway. The Setup URL page will handle the database entry 
      // once the user is forced to log in.
      if (!account) {
        console.log(`Webhook received installation for unknown user ${senderId}. Awaiting Setup URL redirect linking.`);
        return NextResponse.json({ success: true, message: 'Awaiting user login via setup URL' });
      }

      // Add all selected repositories to the database
      const repoPromises = repositories.map((repo: any) => {
        return prisma.repository.upsert({
          where: { githubId: repo.id },
          update: { isActive: true },
          create: {
            githubId: repo.id,
            fullName: repo.full_name,
            owner: repo.full_name.split('/')[0],
            userId: account.userId, // Link to the NextAuth user
          }
        });
      });

      await Promise.all(repoPromises);
      console.log(`Successfully installed app and populated ${repositories.length} repositories.`);
      return NextResponse.json({ success: true, message: 'Repositories populated' });
    }

    // ==========================================
    // 3. NEW: Handle Added Repositories post-installation
    // ==========================================
    if (event === 'installation_repositories' && action === 'added') {
      const senderId = payload.sender.id.toString();
      const account = await prisma.account.findFirst({
        where: { provider: 'github', providerAccountId: senderId },
      });

      if (account) {
        const repoPromises = repositories_added.map((repo: any) => {
          return prisma.repository.upsert({
            where: { githubId: repo.id },
            update: { isActive: true },
            create: {
              githubId: repo.id,
              fullName: repo.full_name,
              owner: repo.full_name.split('/')[0],
              userId: account.userId,
            }
          });
        });
        await Promise.all(repoPromises);
      }
      return NextResponse.json({ success: true, message: 'New repositories added' });
    }

    // ==========================================
    // 4. EXISTING: Handle Pull Requests
    // ==========================================
    if (event === 'pull_request') {
      if (!['opened', 'synchronize', 'reopened'].includes(action)) {
        return NextResponse.json({ message: 'Action not tracked' }, { status: 200 });
      }

      console.log(`Processing PR #${pull_request.number} on ${repository.full_name}`);

      const appId = process.env.GITHUB_APP_ID!;
      const privateKey = process.env.GITHUB_PRIVATE_KEY!.replace(/\\n/g, '\n'); 

      const appClient = new App({ appId, privateKey });
      const octokit = await appClient.getInstallationOctokit(installation.id);

      const { data: pullRequestFiles } = await octokit.rest.pulls.listFiles({
        owner: repository.owner.login,
        repo: repository.name,
        pull_number: pull_request.number,
      });

      const fileNames = pullRequestFiles.map((file: any) => file.filename);

      // Security Scanning
      const findings = await claw.scanPullRequest(fileNames);
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
      
      await octokit.rest.checks.create({
        owner: repository.owner.login,
        repo: repository.name,
        name: 'SecureFlow Scan',
        head_sha: pull_request.head.sha,
        status: 'completed',
        conclusion: conclusion,
        output: {
          title: `Policy Decision: ${decision}`,
          summary: `SecureFlow detected ${findings.length} potential security issues.`,
        }
      });

      if (enrichedFindings.length > 0) {
        let commentBody = `### 🛡️ SecureFlow AI Security Report\n\n`;
        enrichedFindings.forEach((f: any) => {
          commentBody += `**[${f.severity}] ${f.type} in \`${f.fileLocation}\`**\n`;
          commentBody += `> ${f.explanation}\n\n`;
          commentBody += `**Remediation:** ${f.remediation}\n\n---\n`;
        });

        await octokit.rest.issues.createComment({
          owner: repository.owner.login,
          repo: repository.name,
          issue_number: pull_request.number,
          body: commentBody,
        });
      }

      // Persist to DB
      const dbRepo = await prisma.repository.findUnique({
        where: { githubId: repository.id }
      });

      if (dbRepo) {
        const dbPr = await prisma.pullRequest.upsert({
          where: { githubId: pull_request.id },
          update: {
            title: pull_request.title,
            state: pull_request.state, 
            status: decision,
          },
          create: {
            githubId: pull_request.id,
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

      return NextResponse.json({ success: true, decision, findingCount: findings.length });
    }

    return NextResponse.json({ message: 'Event successfully caught but ignored' }, { status: 200 });

  } catch (error) {
    console.error('Webhook Error:', error);
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
  }
}