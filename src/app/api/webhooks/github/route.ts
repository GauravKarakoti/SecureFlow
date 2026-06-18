import { NextRequest, NextResponse } from 'next/server';
import { scanner } from '@/lib/armor/scanner';
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

      if (!account) {
        console.log(`Webhook received installation for unknown user ${senderId}. Awaiting Setup URL redirect linking.`);
        return NextResponse.json({ success: true, message: 'Awaiting user login via setup URL' });
      }

      // Add all selected repositories to the database
      const repoPromises = repositories.map((repo: any) => {
        return prisma.repository.upsert({
          where: { githubId: BigInt(repo.id) },
          update: { isActive: true },
          create: {
            githubId: BigInt(repo.id),
            fullName: repo.full_name,
            owner: repo.full_name.split('/')[0],
            userId: account.userId, 
          }
        });
      });

      await Promise.all(repoPromises);
      console.log(`Successfully installed app and populated ${repositories.length} repositories.`);

      // --- EVENT 1: Repository Added (Installation) ---
      await prisma.auditLog.create({
        data: {
          userId: account.userId,
          action: 'Repository Added',
          resource: repositories.map((r: any) => r.full_name).join(', '),
          metadata: { count: repositories.length, event: 'installation' }
        }
      });
      // ------------------------------------------------

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
            where: { githubId: BigInt(repo.id) },
            update: { isActive: true },
            create: {
              githubId: BigInt(repo.id),
              fullName: repo.full_name,
              owner: repo.full_name.split('/')[0],
              userId: account.userId,
            }
          });
        });
        await Promise.all(repoPromises);

        // --- EVENT 1: Repository Added (Post-Installation) ---
        await prisma.auditLog.create({
          data: {
            userId: account.userId,
            action: 'Repository Added',
            resource: repositories_added.map((r: any) => r.full_name).join(', '),
            metadata: { count: repositories_added.length, event: 'installation_repositories' }
          }
        });
        // -----------------------------------------------------
      }
      return NextResponse.json({ success: true, message: 'New repositories added' });
    }

    if (event === 'pull_request') {
      if (!['opened', 'synchronize', 'reopened'].includes(action)) {
        return NextResponse.json({ message: 'Action not tracked' }, { status: 200 });
      }

      console.log(`Processing PR #${pull_request.number} on ${repository.full_name}`);

      const dbRepo = await prisma.repository.findUnique({
        where: { githubId: BigInt(repository.id) }
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
          resource: `${repository.full_name}#${pull_request.number}`,
          metadata: { action: action, head_sha: pull_request.head.sha }
        }
      });

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

      // --- UPDATE: Pass the active policies to the scanner ---
      const findings = await scanner.scanPullRequest(fileChanges, activePolicies);
      // -------------------------------------------------------
      
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
      
      // --- EVENT 3: Policy Evaluation ---
      await prisma.auditLog.create({
        data: {
          userId: userId,
          action: 'Policy Evaluation',
          resource: `${repository.full_name}#${pull_request.number}`,
          decision: decision,
          metadata: { findingsCount: findings.length }
        }
      });
      // ----------------------------------

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
        commentBody += `⚠️ Detected **${enrichedFindings.length}** potential issues matching your code policies. Please review them before merging.\n\n`;

        enrichedFindings.forEach((f: any) => {
          // Determine color indicator badge based on severity
          const badge = f.severity === 'CRITICAL' ? '🔴 CRITICAL' : (f.severity === 'HIGH' ? '🟠 HIGH' : '🟡 MEDIUM');
          
          commentBody += `#### ${badge} | **${f.type}** in \`${f.fileLocation}\`\n`;
          commentBody += `> ${f.explanation}\n\n`;
          
          // Use collapsible HTML blocks so remediation details don't drown out the screen real estate
          commentBody += `<details>\n<summary><b>🛠️ View Remediation Suggestions</b></summary>\n\n`;
          commentBody += `${f.remediation}\n\n`;
          commentBody += `</details>\n\n`;
          commentBody += `---\n\n`;
        });

        // Update the comment we created earlier
        await octokit.rest.issues.updateComment({
          owner: repository.owner.login,
          repo: repository.name,
          comment_id: pendingComment.data.id,
          body: commentBody,
        });

        // --- EVENT 4: PR Comment Posted ---
        await prisma.auditLog.create({
          data: {
            userId: userId,
            action: 'PR Comment Posted',
            resource: `${repository.full_name}#${pull_request.number}`,
            metadata: { commentType: 'AI Security Report', findingsReported: enrichedFindings.length }
          }
        });
      } else {
        // If no findings, update the comment to show success!
        await octokit.rest.issues.updateComment({
          owner: repository.owner.login,
          repo: repository.name,
          comment_id: pendingComment.data.id,
          body: `### 🛡️ SecureFlow AI Security Report\n\n✅ Scan completed successfully. No vulnerabilities found in the **${fileChanges.length}** analyzed files.`,
        });
      }

      // Persist PR details to DB
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

      return NextResponse.json({ success: true, decision, findingCount: findings.length });
    }

    return NextResponse.json({ message: 'Event successfully caught but ignored' }, { status: 200 });

  } catch (error) {
    console.error('Webhook Error:', error);
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
  }
}