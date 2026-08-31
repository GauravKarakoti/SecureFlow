import { NextRequest, NextResponse } from 'next/server';
import { addWebhookJob } from '@/lib/queue/webhookQueue';
import { withErrorHandler, AppError } from '@/lib/middleware/error-handler';
import { withRateLimit } from '@/lib/middleware/rate-limit';
import {
  isPayloadTooLarge,
  isTrackedEvent,
  normalizeDeliveryId,
  parseGithubSignature,
  parseMaxWebhookBytes,
  parseWebhookPayload,
  payloadByteLength,
  verifySignature,
  webhookJobId,
} from '@/lib/github/webhook-verification';
import prisma from '@/lib/prisma';
import { Octokit } from 'octokit';
import { parseManifestFile } from '@/lib/sbom/dependency-parser';
import { matchVulnerabilities } from '@/lib/sbom/vulnerability-matcher';

/**
 * GitHub webhook ingest (#562).
 *
 * The admission order is deliberate and is the substance of this change:
 *
 *   size → delivery id → signature → parse → dispatch on event
 *
 * The route previously dispatched on `x-github-event` *first* and verified the
 * signature second, so an unauthenticated caller sending `x-github-event: push`
 * received `200 {"message":"Event not tracked"}`. Beyond being a free
 * unauthenticated 200 and an oracle for "endpoint exists" vs "signature
 * rejected", it meant `ping` — GitHub's very first delivery when a webhook is
 * registered — was answered without the secret ever being exercised, so a
 * webhook configured with the wrong secret looked healthy in the GitHub UI.
 *
 * The verification primitives live in `src/lib/github/webhook-verification.ts`
 * so each branch is unit-testable without constructing a request.
 */

async function fetchFileContent(
  octokit: InstanceType<typeof Octokit>,
  owner: string,
  repo: string,
  path: string,
  ref: string
) {
  try {
    // Added .rest namespace
    const { data } = await octokit.rest.repos.getContent({ owner, repo, path, ref });
    if ('content' in data && data.content) {
      return Buffer.from(data.content, 'base64').toString('utf-8');
    }
    return null;
  } catch (error) {
    console.error(`[SBOM] Failed to fetch ${path}:`, error);
    return null;
  }
}

/**
 * Executes routines when an existing Pull Request receives new code commits
 */
export async function handlePullRequestSynchronize(payload: Record<string, unknown> | any) {
  const prNumber = payload.number;
  const repoName = payload.repository?.full_name;
  const headSha = payload.pull_request?.head?.sha;

  console.log(`[PR_SYNC] New code pushed to PR #${prNumber} on repo ${repoName}. Head SHA: ${headSha}`);

  // Extract necessary fields for SBOM scanning
  const { pull_request, repository, installation } = payload;

  if (!pull_request || !repository || !installation) {
    console.warn('[PR_SYNC] Missing required fields for SBOM processing');
    return;
  }

  try {
    // 1. Save/Update PR Record
    const prRecord = await prisma.pullRequest.upsert({
      where: { githubPrId: pull_request.id.toString() },
      update: {
        title: pull_request.title,
        state: pull_request.state,
        updatedAt: new Date()
      },
      create: {
        githubPrId: pull_request.id.toString(),
        title: pull_request.title,
        state: pull_request.state,
        branch: pull_request.head.ref,
        repositoryId: repository.id.toString(),
        repository: {
          connectOrCreate: {
            where: { githubRepoId: repository.id.toString() },
            create: {
              githubRepoId: repository.id.toString(),
              name: repository.full_name,
              owner: repository.owner.login
            }
          }
        }
      }
    });

    const octokit = new Octokit({ auth: process.env.GITHUB_TOKEN });
    const owner = repository.owner.login;
    const repo = repository.name;

    // 2. Get changed files
    // Added .rest namespace
    const { data: files } = await octokit.rest.pulls.listFiles({
      owner,
      repo,
      pull_number: pull_request.number,
    });

    // 3. Standard AI Scan (Existing Logic)
    // ... [Assume existing AI scan logic runs here for code files] ...

    // 4. [NEW] SBOM Dependency Scan Integration
    console.log(`[SBOM] Checking ${files.length} files for manifests...`);

    for (const file of files) {
      // Detect manifest files
      if (file.filename.endsWith('package.json') || file.filename.endsWith('requirements.txt')) {
        console.log(`[SBOM] Detected manifest: ${file.filename}`);

        // Fetch content (using PR head ref to get the version being merged)
        const content = await fetchFileContent(octokit, owner, repo, file.filename, pull_request.head.ref);

        if (content) {
          // Parse dependencies
          const dependencies = parseManifestFile(content, file.filename);

          // Match against CVE database
          const vulnerabilities = matchVulnerabilities(dependencies);

          console.log(`[SBOM] Found ${vulnerabilities.length} vulnerabilities in ${file.filename}`);

          // Save findings to Database
          for (const vuln of vulnerabilities) {
            await prisma.finding.create({
              data: {
                pullRequestId: prRecord.id,
                type: 'DEPENDENCY_VULNERABILITY',
                severity: vuln.severity,
                file: file.filename,
                description: `${vuln.dependency.name}@${vuln.dependency.version}: ${vuln.description}`,
                codeSnippet: `Dependency: ${vuln.dependency.name}\nCurrent: ${vuln.dependency.version}\nPatched: ${vuln.patchedVersion || 'Unknown'}`,
                remediation: `Update ${vuln.dependency.name} to version ${vuln.patchedVersion} or higher.`,
                line: 0, // Line 0 indicates manifest-level finding
                aiExplanation: `Detected known vulnerability ${vuln.cveId} in ${vuln.dependency.name}.`
              }
            });
          }
        }
      }
    }
  } catch (error) {
    console.error('[PR_SYNC] Error during SBOM processing:', error);
    // Don't throw - we still want to queue the job even if SBOM fails
  }
}

/**
 * Triggers security tracking or alert logging loops when repository protection controls change
 */
export async function handleBranchProtectionMutation(payload: Record<string, unknown> | any) {
  const action = payload.action; // 'created', 'edited', or 'deleted'
  const ruleName = payload.rule?.name;
  const repoName = payload.repository?.full_name;

  console.warn(`[SECURITY_GOVERNANCE] Branch protection rule '${ruleName}' was ${action} on repo ${repoName}.`);
  // Hook up secondary administrative logging mechanisms or compliance monitoring flags here
}

const handler = withErrorHandler(async function POST(req: NextRequest) {
  const maxBytes = parseMaxWebhookBytes(process.env.GITHUB_WEBHOOK_MAX_BYTES);

  // 1. Size, from the header, before reading a single byte.
  //
  // `req.text()` buffers the whole body into memory. With a 50/minute rate limit
  // and no cap, one source could make the process buffer ~1.25 GB per minute of
  // unverified bytes — and since verification came after the read, without ever
  // holding a valid signature.
  if (isPayloadTooLarge(req.headers.get('content-length'), maxBytes)) {
    throw new AppError('Webhook payload exceeds the configured size limit', 413);
  }

  const webhookSecret = process.env.GITHUB_WEBHOOK_SECRET;
  if (!webhookSecret) {
    // A deployment fault rather than a caller fault: not operational, so the
    // error handler returns a generic message instead of naming the variable.
    throw new AppError('GITHUB_WEBHOOK_SECRET is not set', 500, false);
  }

  // 2. Delivery ID, required.
  //
  // The worker guards its idempotency check on this value being truthy, so a
  // delivery without the header used to skip the duplicate check entirely — and
  // with `attempts: 3` on the queue, a job failing after the scan but before the
  // completion record was fully re-processed on every retry.
  const deliveryId = normalizeDeliveryId(req.headers.get('x-github-delivery'));
  if (!deliveryId) {
    throw new AppError('Missing or invalid x-github-delivery header', 400);
  }

  const signatureHex = parseGithubSignature(req.headers.get('x-hub-signature-256'));
  if (!signatureHex) {
    throw new AppError('Missing or invalid x-hub-signature-256 header', 401);
  }

  // Read the raw text so the signature is verified over the exact bytes sent,
  // before anything parses them.
  const rawPayloadText = await req.text();

  // `Content-Length` is attacker-supplied, so the real length is re-checked. A
  // chunked request legitimately omits the header, which is why the first check
  // cannot be the only one.
  if (isPayloadTooLarge(payloadByteLength(rawPayloadText), maxBytes)) {
    throw new AppError('Webhook payload exceeds the configured size limit', 413);
  }

  // 3. Signature, before the body is interpreted in any way.
  if (!verifySignature(rawPayloadText, webhookSecret, signatureHex)) {
    throw new AppError('Invalid GitHub webhook signature', 401);
  }

  // 4. Parse.
  //
  // This was a bare `JSON.parse` inline. A verified-but-malformed body threw a
  // SyntaxError with no `statusCode`, so the error handler fell through to 500 —
  // which GitHub treats as retryable, re-delivering a payload that can never
  // succeed.
  const parsed = parseWebhookPayload(rawPayloadText);
  if (!parsed.ok) {
    throw new AppError(parsed.reason, 400);
  }

  const event = req.headers.get('x-github-event');

  // 5. Dispatch — now that the delivery is known to be genuine.
  if (event === 'ping') {
    // Answered only after verification, so a successful ping is real evidence
    // that the configured secret matches ours.
    return NextResponse.json(
      { status: 'pong', deliveryId, message: 'Webhook signature verified' },
      { status: 200 }
    );
  }

  if (!isTrackedEvent(event)) {
    return NextResponse.json({ message: 'Event not tracked', deliveryId }, { status: 200 });
  }

  // Route event actions
  if (event === 'pull_request' && parsed.payload.action === 'synchronize') {
    await handlePullRequestSynchronize(parsed.payload);
  } else if (event === 'branch_protection_rule') {
    await handleBranchProtectionMutation(parsed.payload);
  }

  // 6. Delegate to the queue.
  //
  // The job ID is derived from the delivery ID so BullMQ collapses a replayed
  // delivery before a worker picks it up, rather than leaving the worker's
  // database check as the only defence.
  //
  // All Zod validation, Prisma idempotency checks and DB relations live in the
  // worker that processes this job.
  await addWebhookJob(
    {
      payload: parsed.payload,
      deliveryId,
      event,
    },
    { jobId: webhookJobId(deliveryId) }
  );

  return NextResponse.json({ status: 'queued', deliveryId }, { status: 202 });
});

export const POST = withRateLimit(handler, {
  limit: 50,
  windowSeconds: 60,
  keyPrefix: 'webhook:github',
});
