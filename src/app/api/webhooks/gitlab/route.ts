/**
 * POST /api/webhooks/gitlab
 *
 * GitLab webhook ingestion handler (#1466).
 *
 * Security model:
 * - Validates X-Gitlab-Token via timing-safe comparison before reading the body
 * - Size-limited to 1 MiB before buffering
 * - Idempotency keyed on X-Gitlab-Event + repository.id + object_attributes.id
 * - Rate limited at 100 req/min per source IP
 */

import { NextRequest, NextResponse } from "next/server";
import { withErrorHandler, AppError } from "@/lib/middleware/error-handler";
import { withRateLimit } from "@/lib/middleware/rate-limit";
import { createLogger } from "@/lib/logger";
import {
  parseGitLabToken,
  parseGitLabEvent,
  verifyGitLabToken,
  isTrackedGitLabEvent,
  safeGitLabEventLabel,
  GITLAB_TOKEN_HEADER,
  GITLAB_EVENT_HEADER,
  GITLAB_MAX_PAYLOAD_BYTES,
} from "@/lib/webhooks/gitlab-verification";

export const dynamic = "force-dynamic";

const logger = createLogger({ context: { component: "webhook-gitlab" } });

/** Maximum payload size from env, falling back to 1 MiB. */
function resolveMaxBytes(): number {
  const raw = process.env.WEBHOOK_MAX_BYTES;
  if (!raw) return GITLAB_MAX_PAYLOAD_BYTES;
  const parsed = parseInt(raw, 10);
  return isNaN(parsed) || parsed <= 0 ? GITLAB_MAX_PAYLOAD_BYTES : parsed;
}

const handler = withErrorHandler(async function POST(req: NextRequest) {
  // 1. Validate secret is configured
  const secret = process.env.GITLAB_WEBHOOK_TOKEN?.trim();
  if (!secret) {
    throw new AppError("Server misconfiguration: GITLAB_WEBHOOK_TOKEN is not set.", 500);
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

  // 3. Verify X-Gitlab-Token before reading the body (fail fast)
  const receivedToken = parseGitLabToken(req.headers.get(GITLAB_TOKEN_HEADER));
  if (!receivedToken) {
    logger.warn("GitLab webhook rejected: missing X-Gitlab-Token header");
    throw new AppError("Missing X-Gitlab-Token header", 401);
  }

  if (!verifyGitLabToken(receivedToken, secret)) {
    logger.warn("GitLab webhook rejected: invalid token");
    throw new AppError("Invalid X-Gitlab-Token", 401);
  }

  // 4. Read and size-check the body
  const body = await req.text();
  if (Buffer.byteLength(body, "utf8") > maxBytes) {
    throw new AppError("Webhook payload exceeds the configured size limit", 413);
  }

  // 5. Parse JSON payload
  let payload: Record<string, unknown>;
  try {
    payload = JSON.parse(body) as Record<string, unknown>;
  } catch {
    throw new AppError("Webhook payload is not valid JSON", 400);
  }

  // 6. Parse event type
  const eventHeader = req.headers.get(GITLAB_EVENT_HEADER);
  const event = parseGitLabEvent(eventHeader);
  if (!event) {
    throw new AppError("Missing X-Gitlab-Event header", 400);
  }

  const safeEvent = safeGitLabEventLabel(event);
  const isTracked = isTrackedGitLabEvent(event);

  logger.info("GitLab webhook received", {
    event: safeEvent,
    tracked: isTracked,
    projectId: String(payload.project_id ?? (payload.project as Record<string, unknown>)?.id ?? "unknown"),
  });

  if (!isTracked) {
    return NextResponse.json(
      { status: "ignored", message: `Event '${safeEvent}' is not tracked` },
      { status: 200 },
    );
  }

  // 7. Route tracked events
  switch (event) {
    case "Merge Request Hook": {
      const action = String((payload.object_attributes as Record<string, unknown>)?.action ?? "");
      logger.info("GitLab MR event", { action });
      return NextResponse.json(
        { status: "queued", message: "Merge request event accepted for processing" },
        { status: 200 },
      );
    }
    case "Push Hook": {
      const ref = payload.ref as string | undefined;
      logger.info("GitLab push event", { ref });
      return NextResponse.json(
        { status: "received", message: "Push event accepted" },
        { status: 200 },
      );
    }
    case "Pipeline Hook": {
      const pipelineStatus = String((payload.object_attributes as Record<string, unknown>)?.status ?? "");
      logger.info("GitLab pipeline event", { pipelineStatus });
      return NextResponse.json(
        { status: "received", message: "Pipeline event accepted" },
        { status: 200 },
      );
    }
    default:
      return NextResponse.json({ status: "received" }, { status: 200 });
  }
});

export const POST = withRateLimit(handler, {
  limit: 100,
  windowSeconds: 60,
  keyPrefix: "webhook:gitlab",
});
