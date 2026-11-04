import { NextRequest, NextResponse } from "next/server";
import { addWebhookJob } from "@/lib/queue/webhookQueue";
import { logger } from "@/lib/logger";

export const maxDuration = 60; // optionally increase timeout if not already set

import { withErrorHandler, AppError } from "@/lib/middleware/error-handler";
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
} from "@/lib/github/webhook-verification";
import { isDuplicateDelivery } from "@/lib/github/webhook-dedup";
import { env } from "@/lib/env";
import prisma from "@/lib/prisma";

/**
 * GitHub webhook ingest (#562, #1534).
 *
 * The admission order is deliberate and is the substance of this change:
 *
 *   size → delivery id → signature → deduplication → parse → dispatch on event
 *
 * The route previously dispatched on `x-github-event` *first* and verified the
 * signature second, so an unauthenticated caller sending `x-github-event: push`
 * received `200 {"message":"Event not tracked"}`. Beyond being a free
 * unauthenticated 200 and an oracle for "endpoint exists" vs "signature
 * rejected", it meant `ping` — GitHub's very first delivery when a webhook is
 * registered — was answered without the secret ever being exercised, so a
 * webhook configured with the wrong secret looked healthy in the GitHub UI.
 *
 * Deduplication runs immediately after signature verification so unauthenticated
 * or forged deliveries cannot poison Redis keys, while redelivered webhooks return
 * 200 without enqueuing scans or posting duplicate comments (#1534).
 *
 * The verification primitives live in `src/lib/github/webhook-verification.ts`
 * and `src/lib/github/webhook-dedup.ts` so each branch is unit-testable without
 * constructing a request.
 */

// Runs in the webhook worker now (see `src/lib/queue/worker.ts`); re-exported
// so existing callers and tests keep importing it from here.
export { handlePullRequestSynchronize } from "@/lib/sbom/pull-request-manifests";
export { validateWebhookSignature, verifySignature } from "@/lib/github/webhook-verification";
export { isDuplicateDelivery, recordWebhookDelivery } from "@/lib/github/webhook-dedup";

/**
 * Triggers security tracking or alert logging loops when repository protection controls change
 */
export async function handleBranchProtectionMutation(
  payload: Record<string, unknown> | any,
  correlationId?: string,
) {
  const action = payload.action; // 'created', 'edited', or 'deleted'
  const ruleName = payload.rule?.name;
  const repoName = payload.repository?.full_name;
  const log = correlationId ? logger.child({ correlationId }) : logger;

  const msg = `[SECURITY_GOVERNANCE] Branch protection rule '${ruleName}' was ${action} on repo ${repoName}.`;
  console.warn(msg);
  log.warn(msg, { ruleName, action, repoName, correlationId });
  // Hook up secondary administrative logging mechanisms or compliance monitoring flags here
}

const handler = withErrorHandler(async function POST(req: NextRequest) {
  // 1. Resolve delivery and correlation IDs first (#1537)
  const rawDeliveryId = req.headers.get("x-github-delivery");
  const deliveryId = normalizeDeliveryId(rawDeliveryId);
  const correlationId = deliveryId ?? crypto.randomUUID();
  const log = logger.child({ correlationId, deliveryId: deliveryId ?? undefined });

  // 2. Validate environment configuration
  const secret = process.env.GITHUB_WEBHOOK_SECRET?.trim();
  if (!secret) {
    log.error("Server misconfiguration: GitHub webhook secret is missing.");
    throw new AppError("Server misconfiguration: GitHub webhook secret is missing.", 500);
  }

  const maxBytes = parseMaxWebhookBytes(env.GITHUB_WEBHOOK_MAX_BYTES);

  // 3. Size, from the header, before reading a single byte.
  //
  // `req.text()` buffers the whole body into memory. With a 50/minute rate limit
  // and no cap, one source could make the process buffer ~1.25 GB per minute of
  // unverified bytes — and since verification came after the read, without ever
  // holding a valid signature.
  if (isPayloadTooLarge(req.headers.get("content-length"), maxBytes)) {
    log.warn("Webhook payload exceeds the configured size limit");
    throw new AppError("Webhook payload exceeds the configured size limit", 413);
  }
  const webhookSecret = env.GITHUB_WEBHOOK_SECRET ?? process.env.GITHUB_WEBHOOK_SECRET;
  if (!webhookSecret || !webhookSecret.trim()) {
    log.error("GITHUB_WEBHOOK_SECRET is not set");
    throw new AppError("GITHUB_WEBHOOK_SECRET is not set", 500);
  }

  // 4. Delivery ID, required.
  //
  // The worker guards its idempotency check on this value being truthy, so a
  // delivery without the header used to skip the duplicate check entirely — and
  // with `attempts: 3` on the queue, a job failing after the scan but before the
  // completion record was fully re-processed on every retry.
  if (!deliveryId) {
    log.warn("Missing or invalid x-github-delivery header");
    throw new AppError("Missing or invalid x-github-delivery header", 400);
  }

  const signatureHex = parseGithubSignature(
    req.headers.get("x-hub-signature-256") ?? req.headers.get("X-Hub-Signature-256"),
  );
  if (!signatureHex) {
    const msg = `[SECURITY_WARNING] GitHub webhook rejected: Missing or invalid x-hub-signature-256 header (delivery: ${deliveryId})`;
    console.warn(msg);
    log.warn(msg);
    throw new AppError("Missing or invalid x-hub-signature-256 header", 401);
  }

  // Read the raw text so the signature is verified over the exact bytes sent,
  // before anything parses them.
  // We stream the body if possible to enforce the size limit on unbounded
  // chunked requests and prevent memory exhaustion (OOM).
  let rawPayloadText = "";
  if (req.body) {
    let totalBytes = 0;
    const reader = req.body.getReader();
    const decoder = new TextDecoder("utf-8");
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      totalBytes += value.length;
      if (totalBytes > maxBytes) {
        reader.releaseLock();
        log.warn("Webhook payload exceeds the configured size limit during stream");
        throw new AppError("Webhook payload exceeds the configured size limit", 413);
      }
      rawPayloadText += decoder.decode(value, { stream: true });
    }
    rawPayloadText += decoder.decode();
  } else {
    rawPayloadText = await req.text();
    // `Content-Length` is attacker-supplied, so the real length is re-checked. A
    // chunked request legitimately omits the header, which is why the first check
    // cannot be the only one.
    if (isPayloadTooLarge(payloadByteLength(rawPayloadText), maxBytes)) {
      log.warn("Webhook payload exceeds the configured size limit after read");
      throw new AppError("Webhook payload exceeds the configured size limit", 413);
    }
  }

  // 5. Signature, before the body is interpreted in any way.
  if (!verifySignature(rawPayloadText, secret, signatureHex)) {
    const msg = `[SECURITY_WARNING] GitHub webhook rejected: Invalid signature for delivery ${deliveryId}`;
    console.warn(msg);
    log.warn(msg);
    throw new AppError("Invalid GitHub webhook signature", 401);
  }

  // 5. Deduplication: GitHub retries webhook deliveries and users can redeliver
  // them from app settings. Deduplicate using an atomic set-if-absent in Redis
  // with a 24-hour TTL after signature verification so unauthenticated requests
  // cannot poison keys. Repeat deliveries return 200 without enqueuing a scan (#1534).
  const isDuplicate = await isDuplicateDelivery(deliveryId);
  if (isDuplicate) {
    console.warn(`[WEBHOOK_DEDUPE] Duplicate GitHub webhook delivery ignored: ${deliveryId}`);
    return NextResponse.json(
      { message: "Duplicate webhook delivery ignored", deliveryId },
      { status: 200 },
    );
  }

  // 6. Parse.
  //
  // This was a bare `JSON.parse` inline. A verified-but-malformed body threw a
  // SyntaxError with no `statusCode`, so the error handler fell through to 500 —
  // which GitHub treats as retryable, re-delivering a payload that can never
  // succeed.
  const parsed = parseWebhookPayload(rawPayloadText);
  if (!parsed.ok) {
    log.warn(`Webhook payload parse failed: ${parsed.reason}`);
    throw new AppError(parsed.reason, 400);
  }

  const event = req.headers.get("x-github-event");

  // 7. Dispatch — now that the delivery is known to be genuine and new.
  if (event === "ping") {
    // Answered only after verification, so a successful ping is real evidence
    // that the configured secret matches ours.
    log.info("Received ping event; signature verified");
    return NextResponse.json(
      { status: "pong", deliveryId, correlationId, message: "Webhook signature verified" },
      { status: 200 },
    );
  }

  if (!isTrackedEvent(event)) {
    log.info(`Event not tracked: ${event}`);
    return NextResponse.json(
      { message: "Event not tracked", deliveryId, correlationId },
      { status: 200 },
    );
  }

  // 8. Delegate to the queue.
  //
  // The job ID is derived from the delivery ID so BullMQ collapses a replayed
  // delivery before a worker picks it up, rather than leaving the worker's
  // database check as the only defence.
  //
  // All Zod validation, Prisma idempotency checks and DB relations live in the
  // worker that processes this job.
  //
  // `replaceFailed`: a delivery whose job exhausted its attempts keeps its job ID
  // in the queue, so without this a redelivery of that same delivery (GitHub's
  // "Redeliver" button reuses the delivery ID) is deduped against the dead job,
  // answered 202, and never runs. Only a *failed* job is replaced; a waiting,
  // active or completed one still collapses the replay. The request is already
  // signature-verified, so only GitHub can cause this.
  log.info(`Enqueuing webhook job for event: ${event}`);
  try {
    await addWebhookJob(
      {
        payload: parsed.payload,
        deliveryId,
        event,
        correlationId,
      },
      { jobId: webhookJobId(deliveryId), replaceFailed: true },
    );
    log.info(`Successfully enqueued webhook job for delivery ${deliveryId}`);
  } catch (error: any) {
    const errMsg = `[DLQ_FALLBACK] BullMQ enqueue failed for delivery ${deliveryId}. Routing to Dead Letter Queue...`;
    console.error(errMsg, error);
    log.error(errMsg, { error: error?.message });
    try {
      // Dead-Letter Queue (DLQ) Fallback: Store failed webhook deliveries in the database
      // to ensure no repository scans or push events are skipped during Redis downtime.
      await prisma.webhookDlq.create({
        data: {
          deliveryId,
          event: event || "unknown",
          payload: parsed.payload as any,
          errorMessage: error?.message || "BullMQ enqueue failure",
        },
      });
      const dlqMsg = `[DLQ_FALLBACK] Successfully routed delivery ${deliveryId} to Database DLQ.`;
      console.log(dlqMsg);
      log.info(dlqMsg);
    } catch (dbError: any) {
      const dbErrMsg = `[DLQ_FALLBACK] CRITICAL: Failed to save to Database DLQ for delivery ${deliveryId}`;
      console.error(dbErrMsg, dbError);
      log.error(dbErrMsg, { error: dbError?.message });
    }
  }

  return NextResponse.json({ status: "queued", deliveryId, correlationId }, { status: 202 });
});

export const POST = handler;
