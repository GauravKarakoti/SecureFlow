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
