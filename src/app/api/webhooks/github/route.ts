import { NextRequest, NextResponse } from "next/server";
import { addWebhookJob } from "@/lib/queue/webhookQueue";

export const maxDuration = 60; // optionally increase timeout if not already set
export const config = {
  api: {
    bodyParser: {
      sizeLimit: "10mb",
    },
  },
};

import { withErrorHandler, AppError } from "@/lib/middleware/error-handler";
import { withRateLimit } from "@/lib/middleware/rate-limit";
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
import { env } from "@/lib/env";

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

// Runs in the webhook worker now (see `src/lib/queue/worker.ts`); re-exported
// so existing callers and tests keep importing it from here.
export { handlePullRequestSynchronize } from "@/lib/sbom/pull-request-manifests";

/**
 * Triggers security tracking or alert logging loops when repository protection controls change
 */
export async function handleBranchProtectionMutation(payload: Record<string, unknown> | any) {
  const action = payload.action; // 'created', 'edited', or 'deleted'
  const ruleName = payload.rule?.name;
  const repoName = payload.repository?.full_name;

  console.warn(
    `[SECURITY_GOVERNANCE] Branch protection rule '${ruleName}' was ${action} on repo ${repoName}.`,
  );
  // Hook up secondary administrative logging mechanisms or compliance monitoring flags here
}

const handler = withErrorHandler(async function POST(req: NextRequest) {
  // 1. Validate environment configuration first
  const secret = process.env.GITHUB_WEBHOOK_SECRET?.trim();
  if (!secret) {
    throw new AppError("Server misconfiguration: GitHub webhook secret is missing.", 500);
  }

  const maxBytes = parseMaxWebhookBytes(env.GITHUB_WEBHOOK_MAX_BYTES);

  // 2. Size, from the header, before reading a single byte.
  //
  // `req.text()` buffers the whole body into memory. With a 50/minute rate limit
  // and no cap, one source could make the process buffer ~1.25 GB per minute of
  // unverified bytes — and since verification came after the read, without ever
  // holding a valid signature.
  if (isPayloadTooLarge(req.headers.get("content-length"), maxBytes)) {
    throw new AppError("Webhook payload exceeds the configured size limit", 413);
  }
  const webhookSecret = env.GITHUB_WEBHOOK_SECRET ?? process.env.GITHUB_WEBHOOK_SECRET;
  if (!webhookSecret || !webhookSecret.trim()) {
    throw new AppError("GITHUB_WEBHOOK_SECRET is not set", 500);
  }

  // 3. Delivery ID, required.
  //
  // The worker guards its idempotency check on this value being truthy, so a
  // delivery without the header used to skip the duplicate check entirely — and
  // with `attempts: 3` on the queue, a job failing after the scan but before the
  // completion record was fully re-processed on every retry.
  const deliveryId = normalizeDeliveryId(req.headers.get("x-github-delivery"));
  if (!deliveryId) {
    throw new AppError("Missing or invalid x-github-delivery header", 400);
  }

  const signatureHex = parseGithubSignature(
    req.headers.get("x-hub-signature-256") ?? req.headers.get("X-Hub-Signature-256"),
  );
  if (!signatureHex) {
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
      throw new AppError("Webhook payload exceeds the configured size limit", 413);
    }
  }

  // 4. Signature, before the body is interpreted in any way.
  if (!verifySignature(rawPayloadText, secret, signatureHex)) {
    throw new AppError("Invalid GitHub webhook signature", 401);
  }

  // 5. Parse.
  //
  // This was a bare `JSON.parse` inline. A verified-but-malformed body threw a
  // SyntaxError with no `statusCode`, so the error handler fell through to 500 —
  // which GitHub treats as retryable, re-delivering a payload that can never
  // succeed.
  const parsed = parseWebhookPayload(rawPayloadText);
  if (!parsed.ok) {
    throw new AppError(parsed.reason, 400);
  }

  const event = req.headers.get("x-github-event");

  // 6. Dispatch — now that the delivery is known to be genuine.
  if (event === "ping") {
    // Answered only after verification, so a successful ping is real evidence
    // that the configured secret matches ours.
    return NextResponse.json(
      { status: "pong", deliveryId, message: "Webhook signature verified" },
      { status: 200 },
    );
  }

  if (!isTrackedEvent(event)) {
    return NextResponse.json({ message: "Event not tracked", deliveryId }, { status: 200 });
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
    { jobId: webhookJobId(deliveryId) },
  );

  return NextResponse.json({ status: "queued", deliveryId }, { status: 202 });
});

export const POST = withRateLimit(handler, {
  limit: 50,
  windowSeconds: 60,
  keyPrefix: "webhook:github",
});
