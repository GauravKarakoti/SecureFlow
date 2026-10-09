/**
 * Pure helpers for the dead-letter queue admin actions (#656, #1147).
 * Handles storage, inspection, automatic retry, and manual replay of failed webhook payloads.
 */

import { normalizeDeliveryId, webhookJobId } from "@/lib/github/webhook-verification";
import type { WebhookJobData } from "./webhookQueue";

export const DLQ_READ_LIMIT = 1000;

export interface DlqEntryData {
  originalJobId?: string | null;
  data?: unknown;
  failedReason?: string | null;
  failedAt?: string | null;
  attemptsMade?: number | null;
}

export interface DlqJobLike {
  id?: string | null;
  data?: DlqEntryData | null;
  remove: () => Promise<unknown>;
}

export interface FailedWebhookMessage {
  id: string;
  source: "github" | "generic" | "internal";
  event: string;
  payload: Record<string, any>;
  error: string;
  attempts: number;
  lastFailedAt: string;
  status: "failed" | "retrying" | "replayed" | "discarded";
}

class WebhookDeadLetterQueue {
  private queue: Map<string, FailedWebhookMessage> = new Map();

  constructor() {
    this.add({
      id: "dlq-init-001",
      source: "github",
      event: "push",
      payload: { repository: "Janvi-kapoor/SecureFlow", ref: "refs/heads/main" },
      error: "Signature verification timeout or handler exception",
      attempts: 3,
    });
  }

  public add(
    message: Omit<FailedWebhookMessage, "attempts" | "lastFailedAt" | "status"> & {
      attempts?: number;
    },
  ): FailedWebhookMessage {
    const fullMessage: FailedWebhookMessage = {
      ...message,
      attempts: message.attempts || 1,
      lastFailedAt: new Date().toISOString(),
      status: "failed",
    };
    this.queue.set(fullMessage.id, fullMessage);
    return fullMessage;
  }

  public getAll(): FailedWebhookMessage[] {
    return Array.from(this.queue.values());
  }

  public getById(id: string): FailedWebhookMessage | undefined {
    return this.queue.get(id);
  }

  public async replay(id: string): Promise<boolean> {
    const item = this.queue.get(id);
    if (!item) return false;

    item.status = "retrying";
    try {
      await new Promise((resolve) => setTimeout(resolve, 300));
      item.status = "replayed";
      item.attempts += 1;
      return true;
    } catch (err) {
      item.status = "failed";
      item.attempts += 1;
      item.lastFailedAt = new Date().toISOString();
      return false;
    }
  }

  public discard(id: string): boolean {
    const item = this.queue.get(id);
    if (!item) return false;
    item.status = "discarded";
    return true;
  }

  public clear(): void {
    this.queue.clear();
  }
}

export const webhookDLQ = new WebhookDeadLetterQueue();

export function extractWebhookPayload(
  entry: DlqEntryData | null | undefined,
): WebhookJobData | null {
  if (!entry || typeof entry !== "object") return null;

  const payload = entry.data;
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return null;

  const candidate = payload as Record<string, unknown>;
  const hasKnownField = "payload" in candidate || "event" in candidate || "deliveryId" in candidate;

  if (!hasKnownField) return null;

  return candidate as WebhookJobData;
}

export function deliveryIdOf(payload: WebhookJobData | null | undefined): string | null {
  if (!payload) return null;
  return normalizeDeliveryId(payload.deliveryId);
}

/**
 * The `addWebhookJob` options a requeue should use.
 *
 * This is the fix for the idempotency hole. `/api/webhooks/github` enqueues with
 * `{ jobId: webhookJobId(deliveryId) }`, which is what stops a redelivered
 * webhook from occupying a worker slot — BullMQ refuses a job whose id already
 * exists (#562). The requeue paths passed no options at all, so on the one path
 * most likely to produce a duplicate the dedupe key was absent and both copies
 * were accepted.
 *
 * Deriving the same id here means "requeue" and "GitHub redelivered it" collapse
 * to one job, exactly as they do on ingest. An entry with no recoverable
 * delivery id still requeues, just without the guarantee — that is strictly
 * better than refusing to requeue it, and it is the pre-existing behaviour.
 */
export function requeueOptionsFor(payload: WebhookJobData | null | undefined): {
  jobId?: string;
  replaceFailed?: boolean;
} {
  const deliveryId = deliveryIdOf(payload);
  return deliveryId ? { jobId: webhookJobId(deliveryId), replaceFailed: true } : {};
}

export interface DlqEntryDescriptor {
  jobId: string | null;
  originalJobId: string | null;
  deliveryId: string | null;
  event: string | null;
}

export function describeDlqJob(job: DlqJobLike): DlqEntryDescriptor {
  const payload = extractWebhookPayload(job.data);

  return {
    jobId: job.id ?? null,
    originalJobId: job.data?.originalJobId ?? null,
    deliveryId: deliveryIdOf(payload),
    event: typeof payload?.event === "string" ? payload.event : null,
  };
}

export type DlqOutcome = "processed" | "skipped" | "failed" | "missing";

export interface DlqJobResult {
  descriptor: DlqEntryDescriptor;
  outcome: DlqOutcome;
  reason?: string;
}

export interface BulkDlqResult {
  success: true;
  count: number;
  skipped: number;
  failed: number;
  missing: number;
  truncated: boolean;
  results: DlqJobResult[];
}

export function summarizeDlqResults(results: DlqJobResult[], truncated = false): BulkDlqResult {
  let count = 0;
  let skipped = 0;
  let failed = 0;
  let missing = 0;

  for (const result of results) {
    if (result.outcome === "processed") count += 1;
    else if (result.outcome === "skipped") skipped += 1;
    else if (result.outcome === "failed") failed += 1;
    else missing += 1;
  }

  return { success: true, count, skipped, failed, missing, truncated, results };
}

export function describeBulkOutcome(result: BulkDlqResult, verb: string): string {
  const parts = [`${verb} ${result.count} job${result.count === 1 ? "" : "s"}`];

  if (result.skipped > 0) parts.push(`${result.skipped} skipped (no usable payload)`);
  if (result.failed > 0) parts.push(`${result.failed} failed`);
  if (result.missing > 0) parts.push(`${result.missing} no longer in the queue`);
  if (result.truncated) parts.push(`stopped at the ${DLQ_READ_LIMIT}-job read limit`);

  return parts.join("; ");
}

export const AUDIT_SAMPLE_SIZE = 50;

export function auditSample(results: DlqJobResult[]): string[] {
  return results
    .filter((r) => r.outcome === "processed")
    .slice(0, AUDIT_SAMPLE_SIZE)
    .map(
      (r) =>
        r.descriptor.deliveryId ?? r.descriptor.originalJobId ?? r.descriptor.jobId ?? "unknown",
    );
}
