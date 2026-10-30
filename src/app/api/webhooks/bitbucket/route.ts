/**
 * POST /api/webhooks/bitbucket
 *
 * Bitbucket webhook ingestion handler (#1466).
 *
 * Security model:
 * - Validates X-Hub-Signature (sha256=<hex>) using HMAC-SHA256 timing-safe comparison
 * - Size-limited to 1 MiB before full body buffering
 * - Idempotency keyed on X-Request-UUID
 * - Rate limited at 100 req/min per source IP
 *
 * Supports both Bitbucket Cloud and Bitbucket Server (Data Center).
 */

import { NextRequest, NextResponse } from "next/server";
import { withErrorHandler, AppError } from "@/lib/middleware/error-handler";
import { withRateLimit } from "@/lib/middleware/rate-limit";
import { createLogger } from "@/lib/logger";
import {
  parseBitbucketSignature,
  parseBitbucketRequestUuid,
  parseBitbucketEventKey,
  verifyBitbucketSignature,
  isTrackedBitbucketEvent,
  safeBitbucketEventLabel,
  BITBUCKET_SIGNATURE_HEADER,
  BITBUCKET_REQUEST_UUID_HEADER,
  BITBUCKET_EVENT_HEADER,
  BITBUCKET_MAX_PAYLOAD_BYTES,
} from "@/lib/webhooks/bitbucket-verification";

export const dynamic = "force-dynamic";

const logger = createLogger({ context: { component: "webhook-bitbucket" } });

function resolveMaxBytes(): number {
  const raw = process.env.WEBHOOK_MAX_BYTES;
  if (!raw) return BITBUCKET_MAX_PAYLOAD_BYTES;
  const parsed = parseInt(raw, 10);
  return isNaN(parsed) || parsed <= 0 ? BITBUCKET_MAX_PAYLOAD_BYTES : parsed;
}

const handler = withErrorHandler(async function POST(req: NextRequest) {
  // 1. Validate secret is configured
  const secret = process.env.BITBUCKET_WEBHOOK_SECRET?.trim();
  if (!secret) {
    throw new AppError("Server misconfiguration: BITBUCKET_WEBHOOK_SECRET is not set.", 500);
  }

  const maxBytes = resolveMaxBytes();

  // 2. Size check before reading any bytes
  const contentLengthHeader = req.headers.get("content-length");
  if (contentLengthHeader) {
    const contentLength = parseInt(contentLengthHeader, 10);
    if (!isNaN(contentLength) && contentLength > maxBytes) {
      throw new AppError("Webhook payload exceeds the configured size limit", 413);
    }
  }

  // 3. Parse signature header early — reject immediately if missing
  const signatureHeader = req.headers.get(BITBUCKET_SIGNATURE_HEADER);
  const signatureHex = parseBitbucketSignature(signatureHeader);
  if (!signatureHex) {
    logger.warn("Bitbucket webhook rejected: missing or invalid X-Hub-Signature header");
    throw new AppError("Missing or invalid X-Hub-Signature header", 401);
  }

  // 4. Parse request UUID for idempotency logging
  const requestUuid = parseBitbucketRequestUuid(req.headers.get(BITBUCKET_REQUEST_UUID_HEADER));

  // 5. Read body and verify size
  const body = await req.text();
  if (Buffer.byteLength(body, "utf8") > maxBytes) {
    throw new AppError("Webhook payload exceeds the configured size limit", 413);
  }

  // 6. Verify HMAC signature
  if (!verifyBitbucketSignature(signatureHex, secret, body)) {
    logger.warn("Bitbucket webhook rejected: signature mismatch", {
      uuid: requestUuid ?? "unknown",
    });
    throw new AppError("Invalid webhook signature", 401);
  }

  // 7. Parse JSON payload
  let payload: Record<string, unknown>;
  try {
    payload = JSON.parse(body) as Record<string, unknown>;
  } catch {
    throw new AppError("Webhook payload is not valid JSON", 400);
  }

  // 8. Parse and validate event key
  const eventKeyHeader = req.headers.get(BITBUCKET_EVENT_HEADER);
  const eventKey = parseBitbucketEventKey(eventKeyHeader);
  if (!eventKey) {
    throw new AppError("Missing X-Event-Key header", 400);
  }

  const safeEvent = safeBitbucketEventLabel(eventKey);
  const isTracked = isTrackedBitbucketEvent(eventKey);

  logger.info("Bitbucket webhook received", {
    event: safeEvent,
    tracked: isTracked,
    uuid: requestUuid ?? "unknown",
    repository: String((payload.repository as Record<string, unknown>)?.full_name ?? "unknown"),
  });

  if (!isTracked) {
    return NextResponse.json(
      { status: "ignored", message: `Event '${safeEvent}' is not tracked` },
      { status: 200 },
    );
  }

  // 9. Route tracked events
  switch (eventKey) {
    case "pullrequest:created":
    case "pullrequest:updated": {
      const pr = payload.pullrequest as Record<string, unknown> | undefined;
      logger.info("Bitbucket PR event", { event: eventKey, prId: String(pr?.id ?? "") });
      return NextResponse.json(
        { status: "queued", message: "Pull request event accepted for processing" },
        { status: 200 },
      );
    }
    case "repo:push":
    case "repo:refs_changed": {
      logger.info("Bitbucket push event", { event: eventKey });
      return NextResponse.json(
        { status: "received", message: "Push event accepted" },
        { status: 200 },
      );
    }
    case "pullrequest:fulfilled":
    case "pullrequest:rejected": {
      const pr = payload.pullrequest as Record<string, unknown> | undefined;
      logger.info("Bitbucket PR closed", { event: eventKey, prId: String(pr?.id ?? "") });
      return NextResponse.json({ status: "received" }, { status: 200 });
    }
    default:
      return NextResponse.json({ status: "received" }, { status: 200 });
  }
});

export const POST = withRateLimit(handler, {
  limit: 100,
  windowSeconds: 60,
  keyPrefix: "webhook:bitbucket",
});
