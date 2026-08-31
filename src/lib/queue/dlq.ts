/**
 * Pure helpers for the dead-letter queue admin actions (#656).
 *
 * `src/lib/actions/queue.ts` is a `"use server"` module, so every export there
 * must be an async server action. Everything decidable without Redis therefore
 * lives here, where it can be unit tested directly and where the shared
 * constants have somewhere to sit.
 */

import {
  normalizeDeliveryId,
  webhookJobId,
} from '@/lib/github/webhook-verification';
import type { WebhookJobData } from './webhookQueue';

/**
 * Upper bound on DLQ entries read in one go.
 *
 * `webhookDLQ.getJobs(['waiting'])` was unbounded on all three read paths. The
 * state in which an operator actually opens `/admin/queue` is the one where the
 * DLQ has been filling up unattended, so the unbounded read is at its worst
 * exactly when it is used.
 *
 * A page of a thousand is far more than fits on screen and still trivial to
 * hold; the callers report when they hit it so a bulk action never claims to
 * have covered entries it never saw.
 */
export const DLQ_READ_LIMIT = 1000;

/**
 * What the worker writes into the DLQ.
 *
 * See the `worker.on('failed')` handler in `src/lib/queue/worker.ts`, which adds
 * `{ originalJobId, data, failedReason, failedAt, attemptsMade }`. Every field
 * is optional here because this type describes what was *found* in Redis, not
 * what should have been put there.
 */
export interface DlqEntryData {
  originalJobId?: string | null;
  data?: unknown;
  failedReason?: string | null;
  failedAt?: string | null;
  attemptsMade?: number | null;
}

/** The subset of a BullMQ job the DLQ actions touch. */
export interface DlqJobLike {
  id?: string | null;
  data?: DlqEntryData | null;
  remove: () => Promise<unknown>;
}

/**
 * Recover the original webhook payload from a DLQ entry, or `null` when the
 * entry does not carry one.
 *
 * The requeue paths used to read `job.data.data` and hand it straight to
 * `addWebhookJob`. Nothing guaranteed it was there: an entry written by any
 * other path, or one whose `data` was lost, produced `addWebhookJob(undefined)`
 * — a job the worker cannot process, which fails its three attempts and is
 * routed back to the DLQ. Requeueing one poison entry produced two.
 *
 * A payload is usable when it is a plain object carrying at least one of the
 * three fields `WebhookJobData` is made of. That is deliberately permissive:
 * the worker does its own validation, and this check exists to catch the
 * structurally absent case rather than to re-implement the worker's schema.
 */
export function extractWebhookPayload(entry: DlqEntryData | null | undefined): WebhookJobData | null {
  if (!entry || typeof entry !== 'object') return null;

  const payload = entry.data;
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return null;

  const candidate = payload as Record<string, unknown>;
  const hasKnownField =
    'payload' in candidate || 'event' in candidate || 'deliveryId' in candidate;

  if (!hasKnownField) return null;

  return candidate as WebhookJobData;
}

/**
 * The delivery id a payload was originally admitted under, if it still has one.
 *
 * Read from the payload rather than from the DLQ wrapper because that is where
 * the ingest route puts it (`addWebhookJob({ payload, event, deliveryId }, …)`).
 */
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
export function requeueOptionsFor(payload: WebhookJobData | null | undefined): { jobId?: string } {
  const deliveryId = deliveryIdOf(payload);
  return deliveryId ? { jobId: webhookJobId(deliveryId) } : {};
}

/**
 * A short, non-sensitive description of a DLQ entry, for the audit metadata.
 *
 * Only identifiers and the event name — never the payload, which is the
 * attacker-influenced part and is already subject to the audit minimisation
 * rules in `src/lib/audit/minimization.ts`.
 */
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
    event: typeof payload?.event === 'string' ? payload.event : null,
  };
}

/** How one entry fared in a bulk operation. */
export type DlqOutcome = 'processed' | 'skipped' | 'failed' | 'missing';

export interface DlqJobResult {
  descriptor: DlqEntryDescriptor;
  outcome: DlqOutcome;
  /** Why, when the outcome is not `processed`. */
  reason?: string;
}

/**
 * The shape every bulk DLQ action returns.
 *
 * `success` and `count` are kept because `src/components/admin/DLQTable.tsx`
 * already reads them. The rest is additive: the table previously had no way to
 * tell the operator that four of the twelve entries they selected were left
 * behind, because the action either threw on the first problem or reported a
 * bare `{ success: true }`.
 */
export interface BulkDlqResult {
  success: true;
  /** Entries that were actually requeued or deleted. */
  count: number;
  skipped: number;
  failed: number;
  /** Ids that were asked for but no longer in the DLQ. */
  missing: number;
  /** True when `DLQ_READ_LIMIT` stopped the read before the queue was drained. */
  truncated: boolean;
  /** Per-entry detail, for the toast and for the audit metadata. */
  results: DlqJobResult[];
}

/** Roll per-entry results up into the response shape above. */
export function summarizeDlqResults(
  results: DlqJobResult[],
  truncated = false
): BulkDlqResult {
  let count = 0;
  let skipped = 0;
  let failed = 0;
  let missing = 0;

  for (const result of results) {
    if (result.outcome === 'processed') count += 1;
    else if (result.outcome === 'skipped') skipped += 1;
    else if (result.outcome === 'failed') failed += 1;
    else missing += 1;
  }

  return { success: true, count, skipped, failed, missing, truncated, results };
}

/**
 * One line describing what a bulk operation did, for the operator.
 *
 * Built here rather than in the client component so the wording is the same
 * whether it reaches a toast or the audit log.
 */
export function describeBulkOutcome(result: BulkDlqResult, verb: string): string {
  const parts = [`${verb} ${result.count} job${result.count === 1 ? '' : 's'}`];

  if (result.skipped > 0) parts.push(`${result.skipped} skipped (no usable payload)`);
  if (result.failed > 0) parts.push(`${result.failed} failed`);
  if (result.missing > 0) parts.push(`${result.missing} no longer in the queue`);
  if (result.truncated) parts.push(`stopped at the ${DLQ_READ_LIMIT}-job read limit`);

  return parts.join('; ');
}

/**
 * The delivery ids touched by a bulk operation, bounded for the audit metadata.
 *
 * `AuditLog.resource` is a single string column and `metadata` goes through
 * `sanitizeAuditMetadata`, which has its own size limits. Clearing a DLQ of ten
 * thousand entries should not attempt to write ten thousand ids into one row —
 * the count is the number that matters, and a sample is enough to start an
 * investigation from.
 */
export const AUDIT_SAMPLE_SIZE = 50;

export function auditSample(results: DlqJobResult[]): string[] {
  return results
    .filter((r) => r.outcome === 'processed')
    .slice(0, AUDIT_SAMPLE_SIZE)
    .map((r) => r.descriptor.deliveryId ?? r.descriptor.originalJobId ?? r.descriptor.jobId ?? 'unknown');
}
