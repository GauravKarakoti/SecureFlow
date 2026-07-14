import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { createHmac, timingSafeEqual } from 'crypto';
import { addWebhookJob } from '@/lib/queue/webhookQueue';
import prisma from '@/lib/prisma';
import { withErrorHandler, AppError } from '@/lib/middleware/error-handler';
import { withRateLimit } from '@/lib/middleware/rateLimit';

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

    // Try to link existing Repository and PullRequest initially if present in DB
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

  // Filter events before pushing to the background queue (from fix/255 branch)
  if (!['pull_request', 'installation', 'installation_repositories'].includes(event || '')) {
    return NextResponse.json({ message: 'Event not tracked' }, { status: 200 });
  }

  // Delegate processing to the background queue (from main branch)
  await addWebhookJob({
    payload,
    deliveryId,
    event,
  });

  return NextResponse.json({ status: "queued" }, { status: 200 });
});

export const POST = withRateLimit(handler, { limit: 50, windowSeconds: 60, keyPrefix: 'webhook:github' });