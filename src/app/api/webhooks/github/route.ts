import { NextRequest, NextResponse } from 'next/server';
import { createHmac, timingSafeEqual } from 'crypto';
import { addWebhookJob } from '@/lib/queue/webhookQueue';
import { withErrorHandler, AppError } from '@/lib/middleware/error-handler';
import { withRateLimit } from '@/lib/middleware/rate-limit';

function parseGithubSignature(signatureHeader: string | null): string | null {
  if (!signatureHeader) return null;
  const prefix = 'sha256=';
  return signatureHeader.startsWith(prefix) ? signatureHeader.slice(prefix.length) : null;
}

async function verifyGitHubWebhook(req: NextRequest): Promise<string> {
  const webhookSecret = process.env.GITHUB_WEBHOOK_SECRET;

  if (!webhookSecret) {
    throw new AppError('GITHUB_WEBHOOK_SECRET is not set', 500, false);
  }

  const signatureHex = parseGithubSignature(req.headers.get('x-hub-signature-256'));
  if (!signatureHex) {
    throw new AppError('Missing or invalid x-hub-signature-256 header', 401);
  }

  // Return the raw text so we can verify it before parsing it
  const payloadText = await req.text();
  const digest = createHmac('sha256', webhookSecret).update(payloadText).digest('hex');

  const sigBuf = Buffer.from(signatureHex, 'hex');
  const digBuf = Buffer.from(digest, 'hex');

  if (sigBuf.length !== digBuf.length || !timingSafeEqual(sigBuf, digBuf)) {
    throw new AppError('Invalid GitHub webhook signature', 401);
  }

  return payloadText;
}

const handler = withErrorHandler(async function POST(req: NextRequest) {
  const event = req.headers.get('x-github-event');
  
  // 1. Filter events immediately (Fastest exit)
  if (!['pull_request', 'installation', 'installation_repositories'].includes(event || '')) {
    return NextResponse.json({ message: 'Event not tracked' }, { status: 200 });
  }

  // 2. Verify Signature
  const rawPayloadText = await verifyGitHubWebhook(req);
  const deliveryId = req.headers.get('x-github-delivery');

  // 3. Delegate to Background Queue IMMEDIATELY
  // Note: All Zod validation, Prisma Idempotency checks, and DB relations 
  // MUST be moved to the queue worker processing this job.
  await addWebhookJob({
    payload: JSON.parse(rawPayloadText),
    deliveryId,
    event,
  });

  // 4. Return 202 Accepted instantly
  return NextResponse.json({ status: "queued", deliveryId }, { status: 202 });
});

export const POST = withRateLimit(handler, { limit: 50, windowSeconds: 60, keyPrefix: 'webhook:github' });