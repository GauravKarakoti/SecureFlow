import crypto from "node:crypto";
import prisma from "@/lib/prisma";
import { validateOutboundWebhookUrl } from "./outbound-security";
import {
  computeOutboundWebhookSignature,
  OUTBOUND_SIGNATURE_HEADER,
  OUTBOUND_EVENT_HEADER,
  OUTBOUND_EVENT_ID_HEADER,
  OUTBOUND_TIMESTAMP_HEADER,
} from "./outbound-signature";

export type OutboundEventType =
  "scan.completed" | "scan.blocked" | "finding.created" | "finding.dismissed";

export const OUTBOUND_EVENT_TYPES: readonly OutboundEventType[] = [
  "scan.completed",
  "scan.blocked",
  "finding.created",
  "finding.dismissed",
] as const;

export function isValidOutboundEvent(event: string): event is OutboundEventType {
  return (OUTBOUND_EVENT_TYPES as readonly string[]).includes(event);
}

/**
 * Standard envelope wrapping all outbound webhook events (#1866).
 */
export interface OutboundEventEnvelope<T = Record<string, unknown>> {
  id: string; // evt_<uuid>
  event: OutboundEventType;
  timestamp: string; // ISO-8601 UTC string
  data: T;
}

export interface MinimalFindingSummary {
  id?: string;
  type?: string;
  severity?: string;
  fileLocation?: string | null;
  lineStart?: number | null;
  lineEnd?: number | null;
  fingerprint?: string | null;
}

/**
 * Scrub a finding to ensure ZERO code snippets, secret values, diffs,
 * or stack traces are included in outbound webhook payloads.
 */
export function sanitizeFindingForOutboundPayload(
  finding: MinimalFindingSummary,
): Record<string, unknown> {
  return {
    id: finding.id ?? null,
    type: finding.type ?? "UNKNOWN",
    severity: finding.severity ?? "UNKNOWN",
    fileLocation: finding.fileLocation ?? null,
    lineStart: finding.lineStart ?? null,
    lineEnd: finding.lineEnd ?? null,
    fingerprint: finding.fingerprint ?? null,
  };
}

/**
 * Build a scan.completed payload with zero sensitive content.
 */
export function buildScanCompletedPayload(data: {
  repository: string;
  prNumber: number;
  commitSha: string;
  decision: string;
  findings: readonly MinimalFindingSummary[];
}): OutboundEventEnvelope {
  const eventId = `evt_${crypto.randomUUID()}`;
  const timestamp = new Date().toISOString();

  const sanitizedFindings = data.findings.map(sanitizeFindingForOutboundPayload);
  const severityCounts: Record<string, number> = {
    CRITICAL: 0,
    HIGH: 0,
    MEDIUM: 0,
    LOW: 0,
  };

  for (const f of data.findings) {
    const s = String(f.severity || "").toUpperCase();
    if (s in severityCounts) {
      severityCounts[s] = (severityCounts[s] || 0) + 1;
    }
  }

  return {
    id: eventId,
    event: "scan.completed",
    timestamp,
    data: {
      repository: data.repository,
      prNumber: data.prNumber,
      commitSha: data.commitSha,
      decision: data.decision,
      totalFindings: sanitizedFindings.length,
      severityCounts,
      findings: sanitizedFindings,
    },
  };
}

/**
 * Build a scan.blocked payload with zero sensitive content.
 */
export function buildScanBlockedPayload(data: {
  repository: string;
  prNumber: number;
  commitSha: string;
  decision: string;
  findings: readonly MinimalFindingSummary[];
}): OutboundEventEnvelope {
  const env = buildScanCompletedPayload(data);
  return {
    ...env,
    event: "scan.blocked",
  };
}

/**
 * Build a finding.created payload with zero sensitive content.
 */
export function buildFindingCreatedPayload(data: {
  repository: string;
  prNumber?: number;
  commitSha?: string;
  finding: MinimalFindingSummary;
}): OutboundEventEnvelope {
  const eventId = `evt_${crypto.randomUUID()}`;
  const timestamp = new Date().toISOString();

  return {
    id: eventId,
    event: "finding.created",
    timestamp,
    data: {
      repository: data.repository,
      prNumber: data.prNumber ?? null,
      commitSha: data.commitSha ?? null,
      finding: sanitizeFindingForOutboundPayload(data.finding),
    },
  };
}

/**
 * Build a finding.dismissed payload with zero sensitive content.
 */
export function buildFindingDismissedPayload(data: {
  repository: string;
  fingerprint: string;
  status: string;
  reason?: string | null;
  dismissedAt?: string | null;
}): OutboundEventEnvelope {
  const eventId = `evt_${crypto.randomUUID()}`;
  const timestamp = new Date().toISOString();

  return {
    id: eventId,
    event: "finding.dismissed",
    timestamp,
    data: {
      repository: data.repository,
      fingerprint: data.fingerprint,
      status: data.status,
      reason: data.reason ?? null,
      dismissedAt: data.dismissedAt ?? timestamp,
    },
  };
}

export interface DeliveryOptions {
  maxAttempts?: number;
  timeoutMs?: number;
  initialBackoffMs?: number;
  fetchFn?: typeof fetch;
  dnsLookup?: (host: string) => Promise<string[]>;
  persistLog?: boolean;
}

export interface DeliveryResult {
  success: boolean;
  webhookId: string;
  eventId: string;
  event: OutboundEventType;
  statusCode?: number | null;
  error?: string | null;
  attempts: number;
}

/**
 * Deliver an event payload to a single webhook endpoint with SSRF verification,
 * HMAC signing, timeout, and exponential backoff retries.
 */
export async function deliverOutboundWebhook(
  webhook: { id: string; url: string; secret: string },
  envelope: OutboundEventEnvelope,
  options: DeliveryOptions = {},
): Promise<DeliveryResult> {
  const maxAttempts = options.maxAttempts ?? 3;
  const timeoutMs = options.timeoutMs ?? 5000;
  const initialBackoffMs = options.initialBackoffMs ?? 500;
  const fetchFn = options.fetchFn ?? fetch;
  const shouldPersist = options.persistLog !== false;

  // 1. SSRF pre-flight validation (re-verify URL and DNS right before dispatch)
  const ssrfCheck = await validateOutboundWebhookUrl(webhook.url, {
    dnsLookup: options.dnsLookup,
  });

  if (!ssrfCheck.ok) {
    const errorMsg = `Delivery blocked: ${ssrfCheck.error}`;
    if (shouldPersist && prisma?.outboundWebhookDelivery?.create) {
      try {
        await prisma.outboundWebhookDelivery.create({
          data: {
            webhookId: webhook.id,
            eventId: envelope.id,
            event: envelope.event,
            statusCode: null,
            error: errorMsg,
            attempts: 1,
            deliveredAt: null,
          },
        });
      } catch (dbErr) {
        console.error("[OutboundWebhook] Failed to persist SSRF block delivery log:", dbErr);
      }
    }

    return {
      success: false,
      webhookId: webhook.id,
      eventId: envelope.id,
      event: envelope.event,
      statusCode: null,
      error: errorMsg,
      attempts: 1,
    };
  }

  // 2. Prepare payload & cryptographic signature
  const body = JSON.stringify(envelope);
  const signature = computeOutboundWebhookSignature(body, webhook.secret);

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    [OUTBOUND_SIGNATURE_HEADER]: signature,
    [OUTBOUND_EVENT_HEADER]: envelope.event,
    [OUTBOUND_EVENT_ID_HEADER]: envelope.id,
    [OUTBOUND_TIMESTAMP_HEADER]: envelope.timestamp,
    "User-Agent": "SecureFlow-Webhook/1.0",
  };

  let attempts = 0;
  let lastStatusCode: number | null = null;
  let lastError: string | null = null;
  let delivered = false;

  while (attempts < maxAttempts) {
    attempts++;
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);

      const response = await fetchFn(webhook.url, {
        method: "POST",
        headers,
        body,
        signal: controller.signal,
      });

      clearTimeout(timer);
      lastStatusCode = response.status;

      if (response.ok) {
        delivered = true;
        lastError = null;
        break;
      }

      lastError = `Endpoint answered HTTP ${response.status} ${response.statusText || ""}`.trim();
    } catch (err: any) {
      lastError =
        err?.name === "AbortError"
          ? `Request timed out after ${timeoutMs}ms`
          : err?.message || "Network error";
    }

    // Wait with exponential backoff before retrying
    if (attempts < maxAttempts && initialBackoffMs > 0) {
      const delay = initialBackoffMs * Math.pow(2, attempts - 1);
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }

  // 3. Persist delivery log to database
  if (shouldPersist && prisma?.outboundWebhookDelivery?.create) {
    try {
      await prisma.outboundWebhookDelivery.create({
        data: {
          webhookId: webhook.id,
          eventId: envelope.id,
          event: envelope.event,
          statusCode: lastStatusCode,
          error: delivered ? null : lastError,
          attempts,
          deliveredAt: delivered ? new Date() : null,
        },
      });
    } catch (dbErr) {
      console.error("[OutboundWebhook] Failed to persist delivery log:", dbErr);
    }
  }

  return {
    success: delivered,
    webhookId: webhook.id,
    eventId: envelope.id,
    event: envelope.event,
    statusCode: lastStatusCode,
    error: delivered ? null : lastError,
    attempts,
  };
}

/**
 * Dispatch an outbound webhook event asynchronously to all matching active endpoints
 * owned by the user.
 */
export async function dispatchOutboundWebhooksForUser(
  userId: string,
  event: OutboundEventType,
  envelopeBuilder: () => OutboundEventEnvelope,
  options?: DeliveryOptions,
): Promise<DeliveryResult[]> {
  if (!userId || !prisma?.outboundWebhook?.findMany) return [];

  let webhooks: Array<{ id: string; url: string; secret: string; events: string[] }> = [];
  try {
    webhooks = await prisma.outboundWebhook.findMany({
      where: {
        userId,
        enabled: true,
      },
      select: {
        id: true,
        url: true,
        secret: true,
        events: true,
      },
    });
  } catch (err) {
    console.error("[OutboundWebhook] Failed to query user webhooks:", err);
    return [];
  }

  const matchingWebhooks = webhooks.filter((w) => w.events.includes(event));
  if (matchingWebhooks.length === 0) return [];

  const results = await Promise.allSettled(
    matchingWebhooks.map((webhook) => {
      // Build envelope for each endpoint (each gets unique event ID / timestamp)
      const envelope = envelopeBuilder();
      return deliverOutboundWebhook(webhook, envelope, options);
    }),
  );

  return results.map((r, idx) => {
    if (r.status === "fulfilled") return r.value;
    return {
      success: false,
      webhookId: matchingWebhooks[idx].id,
      eventId: "unknown",
      event,
      statusCode: null,
      error: r.reason instanceof Error ? r.reason.message : String(r.reason),
      attempts: 1,
    };
  });
}
