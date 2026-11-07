/**
 * Multi-channel blocked-scan notifications dispatcher (Slack & Microsoft Teams).
 *
 * Requirements:
 *  - When a scan ends as BLOCKED (critical finding), post a short message with repo,
 *    PR link, severity counts, and dashboard link.
 *  - Never include code snippets or secret values in the message.
 *  - Deduplication: BLOCKED scans trigger one notification per scan (no duplicates on retries/redeliveries).
 *  - Send asynchronously with timeout; failure cannot delay or fail the scan.
 *  - Log each notification attempt to the audit log.
 */

import prisma from "@/lib/prisma";
import { redis } from "@/lib/queue/redis";
import { countBySeverity, type Severity } from "@/lib/severity";
import { sanitizeAuditLogInput } from "@/lib/audit/minimization";
import { sendSlackAlert, type SlackMessage } from "./slack";
import { sendTeamsAlert, buildTeamsAlert, type TeamsFindingSummary } from "./teams";

export const NOTIFICATION_DEDUPE_TTL_SECONDS = 86_400; // 24 hours
export const NOTIFICATION_DEDUPE_PREFIX = "notification:scan:blocked:";

export interface BlockedScanFinding {
  severity: Severity;
  type?: string;
}

export interface NotifyBlockedScanParams {
  scanJobId?: string;
  deliveryId?: string | null;
  correlationId?: string;
  userId?: string | null;
  repositoryFullName: string;
  prNumber: number;
  findings: readonly BlockedScanFinding[];
  decision: string; // "BLOCKED" or "BLOCK"
}

export function blockedScanDedupeKey(keyIdentifier: string): string {
  return `${NOTIFICATION_DEDUPE_PREFIX}${keyIdentifier}`;
}

/**
 * Checks if a notification has already been sent for this scan/delivery.
 * Uses atomic SET ... NX in Redis with a 24-hour TTL.
 * Returns true if this is the first attempt (allowed to proceed), false if duplicate.
 */
export async function claimNotificationDispatch(
  keyIdentifier: string,
  redisClient: any = redis,
): Promise<boolean> {
  if (!keyIdentifier || typeof keyIdentifier !== "string" || !keyIdentifier.trim()) {
    return true; // No key provided, allow sending
  }

  if (!redisClient || typeof redisClient.set !== "function") {
    return true; // Fallback to allowing if Redis is unavailable
  }

  try {
    const key = blockedScanDedupeKey(keyIdentifier.trim());
    const res = await redisClient.set(key, "1", "EX", NOTIFICATION_DEDUPE_TTL_SECONDS, "NX");
    return res === "OK";
  } catch (err) {
    console.warn(`[NotificationDispatch] Redis dedupe check failed; continuing safely:`, err);
    return true;
  }
}

/**
 * Build a concise Slack message for a BLOCKED scan without snippets or secrets.
 */
export function buildBlockedSlackAlert(
  repositoryFullName: string,
  prNumber: number,
  findings: readonly BlockedScanFinding[],
): SlackMessage {
  const counts = countBySeverity(findings as any);
  const prUrl = `https://github.com/${repositoryFullName}/pull/${prNumber}`;
  const appUrl = (process.env.NEXT_PUBLIC_APP_URL || "http://localhost:3000").replace(/\/+$/, "");
  const dashboardUrl = `${appUrl}/dashboard`;

  const severityTextParts: string[] = [];
  if (counts.CRITICAL > 0) severityTextParts.push(`*${counts.CRITICAL}* Critical`);
  if (counts.HIGH > 0) severityTextParts.push(`*${counts.HIGH}* High`);
  if (counts.MEDIUM > 0) severityTextParts.push(`*${counts.MEDIUM}* Medium`);
  if (counts.LOW > 0) severityTextParts.push(`*${counts.LOW}* Low`);

  const breakdown = severityTextParts.length > 0 ? severityTextParts.join(", ") : "Critical issues";

  return {
    text: `🛑 SecureFlow BLOCKED: Security Gate Failed for ${repositoryFullName}#${prNumber}`,
    blocks: [
      {
        type: "header",
        text: {
          type: "plain_text",
          text: "🛑 SecureFlow Scan BLOCKED",
          emoji: true,
        },
      },
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: `A security scan for *<${prUrl}|${repositoryFullName}#${prNumber}>* has ended with status *BLOCKED*.\n\n*Severity Summary:* ${breakdown}`,
        },
      },
      {
        type: "actions",
        elements: [
          {
            type: "button",
            text: { type: "plain_text", text: "View Pull Request", emoji: true },
            url: prUrl,
          },
          {
            type: "button",
            text: { type: "plain_text", text: "Open Dashboard", emoji: true },
            url: dashboardUrl,
          },
        ],
      },
    ],
  };
}

/**
 * Dispatches notifications to Slack and Microsoft Teams when a scan ends as BLOCKED.
 * Runs asynchronously and logs each attempt to the audit log.
 */
export async function notifyBlockedScan(params: NotifyBlockedScanParams): Promise<{
  slackSent: boolean;
  teamsSent: boolean;
  deduplicated: boolean;
}> {
  const isBlocked =
    params.decision === "BLOCKED" ||
    params.decision === "BLOCK" ||
    String(params.decision).toUpperCase().includes("BLOCK");

  if (!isBlocked) {
    return { slackSent: false, teamsSent: false, deduplicated: false };
  }

  // Deduplication check: deliveryId is preferred, falling back to scanJobId
  const dedupeIdentifier = params.deliveryId || params.scanJobId;
  if (dedupeIdentifier) {
    const isFirstClaim = await claimNotificationDispatch(dedupeIdentifier);
    if (!isFirstClaim) {
      console.log(
        `[NotificationDispatch] Skipping duplicate notification for scan ${dedupeIdentifier}`,
      );
      return { slackSent: false, teamsSent: false, deduplicated: true };
    }
  }

  let slackWebhookUrl: string | null = null;
  let teamsWebhookUrl: string | null = null;

  if (params.userId) {
    try {
      const user = await prisma.user.findUnique({
        where: { id: params.userId },
        select: { slackWebhookUrl: true, teamsWebhookUrl: true },
      });
      slackWebhookUrl = user?.slackWebhookUrl || null;
      teamsWebhookUrl = user?.teamsWebhookUrl || null;
    } catch (err) {
      console.error("[NotificationDispatch] Failed to fetch user webhook settings:", err);
    }
  }

  let slackSent = false;
  let teamsSent = false;

  // 1. Post to Slack if configured
  if (slackWebhookUrl && slackWebhookUrl.trim()) {
    try {
      const slackMsg = buildBlockedSlackAlert(
        params.repositoryFullName,
        params.prNumber,
        params.findings,
      );
      slackSent = await sendSlackAlert(slackWebhookUrl.trim(), slackMsg);
    } catch (err) {
      console.error("[NotificationDispatch] Slack dispatch error:", err);
    }

    // Audit log attempt
    if (params.userId) {
      try {
        await prisma.auditLog.create({
          data: sanitizeAuditLogInput({
            userId: params.userId,
            action: "NOTIFICATION_DISPATCH_SLACK",
            resource: `${params.repositoryFullName}#${params.prNumber}`,
            decision: slackSent ? "SUCCESS" : "FAILURE",
            metadata: {
              channel: "SLACK",
              correlationId: params.correlationId,
              scanJobId: params.scanJobId,
              deliveryId: params.deliveryId,
              status: slackSent ? "DELIVERED" : "FAILED",
            },
          }),
        });
      } catch (logErr) {
        console.error("[NotificationDispatch] Failed to log Slack notification to audit log:", logErr);
      }
    }
  }

  // 2. Post to Microsoft Teams if configured
  if (teamsWebhookUrl && teamsWebhookUrl.trim()) {
    try {
      const teamsCard = buildTeamsAlert({
        repositoryFullName: params.repositoryFullName,
        prNumber: params.prNumber,
        findings: params.findings as TeamsFindingSummary[],
      });
      teamsSent = await sendTeamsAlert(teamsWebhookUrl.trim(), teamsCard);
    } catch (err) {
      console.error("[NotificationDispatch] Teams dispatch error:", err);
    }

    // Audit log attempt
    if (params.userId) {
      try {
        await prisma.auditLog.create({
          data: sanitizeAuditLogInput({
            userId: params.userId,
            action: "NOTIFICATION_DISPATCH_TEAMS",
            resource: `${params.repositoryFullName}#${params.prNumber}`,
            decision: teamsSent ? "SUCCESS" : "FAILURE",
            metadata: {
              channel: "TEAMS",
              correlationId: params.correlationId,
              scanJobId: params.scanJobId,
              deliveryId: params.deliveryId,
              status: teamsSent ? "DELIVERED" : "FAILED",
            },
          }),
        });
      } catch (logErr) {
        console.error("[NotificationDispatch] Failed to log Teams notification to audit log:", logErr);
      }
    }
  }

  return { slackSent, teamsSent, deduplicated: false };
}
