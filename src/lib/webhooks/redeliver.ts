/**
 * GitHub Webhook Delivery Redelivery Service (#2013)
 *
 * Calls the GitHub App deliveries redelivery API:
 * POST /app/hook/deliveries/{delivery_id}/attempts
 *
 * Requirements:
 * - Admin authorization only
 * - Authenticated with GitHub App JWT
 * - Rate limited
 * - Audited in AuditLog
 * - Graceful error handling (permissions, not found, rate limits, 3-day window expiration)
 */

import { auth } from "@/auth";
import prisma from "@/lib/prisma";
import { createGitHubAppClient } from "@/lib/github/app-auth";
import { checkRateLimitDetailed } from "@/lib/redis";
import { createLogger } from "@/lib/logger";

const log = createLogger({ context: { component: "webhook-redelivery" } });

/** Rate limit: 10 redelivery attempts per admin user per minute */
export const REDELIVERY_RATE_LIMIT = 10;
export const REDELIVERY_RATE_WINDOW_SECONDS = 60;

/** Eligible reason codes or outcomes for redelivery */
export const ELIGIBLE_REDELIVERY_REASON_CODES = new Set([
  "REPO_DISABLED",
  "SCAN_FAILED",
  "INTERNAL_ERROR",
  "RATE_LIMITED",
  "BAD_SIGNATURE",
  "MISSING_SIGNATURE",
  "INVALID_PAYLOAD",
]);

export interface RedeliverResult {
  success: boolean;
  statusCode?: number;
  message: string;
  deliveryId: string;
}

/**
 * Checks whether a delivery item is eligible for manual redelivery.
 * Redelivery is appropriate when an event failed (outcome === 'rejected' or reasonCode === 'SCAN_FAILED')
 * or was skipped due to repository configuration (e.g. REPO_DISABLED) that an admin may have just enabled.
 */
export function isDeliveryEligibleForRedelivery(delivery: {
  outcome: string;
  reasonCode: string;
}): boolean {
  if (delivery.outcome === "rejected") {
    return true;
  }
  if (ELIGIBLE_REDELIVERY_REASON_CODES.has(delivery.reasonCode)) {
    return true;
  }
  return false;
}

/**
 * Executes redelivery for a stored webhook delivery ID.
 */
export async function redeliverWebhookDelivery(
  deliveryId: string,
  options: {
    appClient?: any;
    skipAuth?: boolean;
    userId?: string;
    userName?: string;
  } = {},
): Promise<RedeliverResult> {
  const trimmedId = deliveryId?.trim();
  if (!trimmedId) {
    return {
      success: false,
      statusCode: 400,
      message: "Delivery ID is required.",
      deliveryId: "",
    };
  }

  // 1. Authenticate and verify ADMIN permissions
  let adminUserId = options.userId;
  let adminUserName = options.userName;

  if (!options.skipAuth) {
    const session = await auth();
    if (!session?.user || !session.user.roles?.includes("ADMIN")) {
      return {
        success: false,
        statusCode: 403,
        message: "Forbidden: Admin access required to redeliver webhook events.",
        deliveryId: trimmedId,
      };
    }
    adminUserId = session.user.id;
    adminUserName = session.user.name || session.user.email || undefined;
  }

  // 2. Rate limiting (per admin user or IP)
  const rateLimitKey = `rate-limit:webhook-redeliver:${adminUserId || "system"}`;
  const rateLimitCheck = await checkRateLimitDetailed(
    rateLimitKey,
    REDELIVERY_RATE_LIMIT,
    REDELIVERY_RATE_WINDOW_SECONDS,
  );

  if (!rateLimitCheck.allowed) {
    return {
      success: false,
      statusCode: 429,
      message: `Rate limit exceeded. Please wait ${Math.ceil(
        (rateLimitCheck.resetAt - Date.now()) / 1000,
      )}s before retrying redelivery.`,
      deliveryId: trimmedId,
    };
  }

  // 3. Look up stored delivery record in database
  const storedDelivery = await prisma.webhookDelivery.findFirst({
    where: { deliveryId: trimmedId },
    orderBy: { createdAt: "desc" },
  });

  // 4. Request redelivery from GitHub App API using App JWT
  let appClient = options.appClient;
  if (!appClient) {
    try {
      appClient = createGitHubAppClient();
    } catch (credErr: any) {
      log.error("[WebhookRedelivery] GitHub App credentials not configured:", credErr);
      return {
        success: false,
        statusCode: 500,
        message: "GitHub App credentials are not configured or invalid.",
        deliveryId: trimmedId,
      };
    }
  }

  let statusCode = 202;
  const outcomeMessage = "Redelivery request accepted by GitHub.";

  try {
    // If the deliveryId is numeric (GitHub internal delivery ID) or UUID (delivery GUID),
    // POST /app/hook/deliveries/{delivery_id}/attempts calls the GitHub App redeliver API.
    const response = await appClient.octokit.request(
      "POST /app/hook/deliveries/{delivery_id}/attempts",
      {
        delivery_id: trimmedId,
        headers: {
          "X-GitHub-Api-Version": "2022-11-28",
        },
      },
    );

    statusCode = response?.status || 202;
  } catch (err: any) {
    const errorStatus = err.status || err.statusCode || 500;
    const errorMessage = err.message || "Failed to trigger redelivery on GitHub.";

    log.warn("[WebhookRedelivery] GitHub App redeliver failed", {
      deliveryId: trimmedId,
      status: errorStatus,
      error: errorMessage,
    });

    let friendlyError = errorMessage;
    if (errorStatus === 404) {
      friendlyError =
        "Delivery not found on GitHub. GitHub retains webhook deliveries for up to 3 days.";
    } else if (errorStatus === 403 || errorStatus === 401) {
      friendlyError =
        "GitHub App missing permissions or unauthorized to redeliver webhook deliveries.";
    } else if (errorStatus === 422) {
      friendlyError =
        "Delivery cannot be redelivered (it may have exceeded the 3-day retention limit).";
    }

    // Audit failed redelivery attempt
    await recordRedeliveryAudit({
      userId: adminUserId,
      deliveryId: trimmedId,
      repository: storedDelivery?.repository,
      eventType: storedDelivery?.eventType,
      decision: "REJECTED",
      statusCode: errorStatus,
      message: friendlyError,
    });

    return {
      success: false,
      statusCode: errorStatus,
      message: friendlyError,
      deliveryId: trimmedId,
    };
  }

  // 5. Audit successful redelivery
  await recordRedeliveryAudit({
    userId: adminUserId,
    deliveryId: trimmedId,
    repository: storedDelivery?.repository,
    eventType: storedDelivery?.eventType,
    decision: "ACCEPTED",
    statusCode,
    message: outcomeMessage,
  });

  return {
    success: true,
    statusCode,
    message: outcomeMessage,
    deliveryId: trimmedId,
  };
}

async function recordRedeliveryAudit(params: {
  userId?: string;
  deliveryId: string;
  repository?: string | null;
  eventType?: string | null;
  decision: string;
  statusCode: number;
  message: string;
}) {
  try {
    await prisma.auditLog.create({
      data: {
        userId: params.userId || null,
        action: "WEBHOOK_REDELIVER",
        resource: `webhook_delivery:${params.deliveryId}`,
        decision: params.decision,
        metadata: {
          deliveryId: params.deliveryId,
          repository: params.repository || null,
          eventType: params.eventType || null,
          statusCode: params.statusCode,
          message: params.message,
          timestamp: new Date().toISOString(),
        },
      },
    });
  } catch (auditErr) {
    log.error("[WebhookRedelivery] Failed to write audit log:", {
      error: auditErr instanceof Error ? auditErr.message : String(auditErr),
    });
  }
}
