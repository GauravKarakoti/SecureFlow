"use server";

import prisma from '@/lib/prisma';
import { webhookQueue, webhookDLQ, addWebhookJob } from '@/lib/queue/webhookQueue';
import { auth } from '@/auth';
import { revalidatePath } from 'next/cache';
import { sanitizeAuditLogInput } from '@/lib/audit/minimization';
import {
  AUDIT_SAMPLE_SIZE,
  DLQ_READ_LIMIT,
  auditSample,
  describeBulkOutcome,
  describeDlqJob,
  extractWebhookPayload,
  requeueOptionsFor,
  summarizeDlqResults,
  type BulkDlqResult,
  type DlqJobLike,
  type DlqJobResult,
} from '@/lib/queue/dlq';

/**
 * Admin gate for every action in this file.
 *
 * The role check used to be copy-pasted at the top of all eleven exports, which
 * is eleven chances for the twelfth to be added without one. `requireAdmin()`
 * mirrors the helper `src/lib/actions/admin.ts` already uses and returns the
 * session, since the audit writes below need the actor id.
 *
 * Not exported: this module is `"use server"`, so anything exported from it
 * becomes a callable server action.
 */
async function requireAdmin() {
  const session = await auth();
  const roles = (session?.user as any)?.roles || [];

  if (!roles.includes("ADMIN")) {
    throw new Error("Unauthorized");
  }

  return session as any;
}

/** Whether the app is running against the mock database rather than Redis. */
function isMockMode(): boolean {
  return process.env.NEXT_PUBLIC_MOCK_DB === 'true';
}

/**
 * Record a DLQ operation in the audit log.
 *
 * Clearing the dead-letter queue discards the record of every webhook delivery
 * that failed to scan, and requeueing replays them. Both are more consequential
 * than the role changes and triage decisions that already write an `AuditLog`
 * row, and neither wrote anything at all.
 *
 * Deliberately non-fatal: an audit write that fails must not turn a completed
 * queue operation into an error the operator will retry, which would be the
 * more damaging outcome. It is logged instead.
 */
async function recordDlqAudit(
  actorId: string | null,
  action: string,
  result: BulkDlqResult,
  extra: Record<string, unknown> = {}
): Promise<void> {
  if (isMockMode()) return;

  try {
    await prisma.auditLog.create({
      data: sanitizeAuditLogInput({
        userId: actorId,
        action,
        resource: `dlq:${result.count}`,
        decision: result.failed > 0 ? 'PARTIAL' : 'OK',
        metadata: {
          ...extra,
          processed: result.count,
          skipped: result.skipped,
          failed: result.failed,
          missing: result.missing,
          truncated: result.truncated,
          // Bounded on purpose — see AUDIT_SAMPLE_SIZE.
          sampleLimit: AUDIT_SAMPLE_SIZE,
          deliveryIds: auditSample(result.results),
        },
      }),
    });
  } catch (err) {
    console.error('[DLQ] Failed to write audit entry:', (err as Error)?.message);
  }
}

/**
 * Read waiting DLQ entries, bounded.
 *
 * `getJobs(['waiting'])` with no range read the entire dead-letter queue into
 * the server action's memory. One extra entry is requested so the caller can
 * tell a full page from a truncated one and say so, rather than implying it
 * covered everything.
 */
async function readDlqJobs(): Promise<{ jobs: DlqJobLike[]; truncated: boolean }> {
  const fetched = ((await webhookDLQ.getJobs(['waiting'], 0, DLQ_READ_LIMIT)) ??
    []) as DlqJobLike[];
  const truncated = fetched.length > DLQ_READ_LIMIT;

  return { jobs: truncated ? fetched.slice(0, DLQ_READ_LIMIT) : fetched, truncated };
}

/**
 * Requeue one DLQ entry.
 *
 * Two things changed from the original `addWebhookJob(job.data.data)`:
 *
 * 1. The payload is validated first, so a malformed entry is skipped rather
 *    than enqueued as `undefined` — which the worker cannot process, so it
 *    failed three more times and was routed straight back to the DLQ.
 * 2. The entry is removed from the DLQ *before* it is added to the main queue,
 *    and the add carries the delivery-derived `jobId`. The old order was
 *    add-then-remove with no id: a failure between the two left the job in both
 *    queues, and nothing downstream deduped it because the dedupe key was
 *    missing.
 *
 * Removing first means the worst case is a lost requeue the operator can
 * observe and retry, instead of a silent duplicate scan.
 */
async function requeueOne(job: DlqJobLike): Promise<DlqJobResult> {
  const descriptor = describeDlqJob(job);
  const payload = extractWebhookPayload(job.data);

  if (!payload) {
    return {
      descriptor,
      outcome: 'skipped',
      reason: 'DLQ entry carries no usable webhook payload',
    };
  }

  try {
    await job.remove();
    await addWebhookJob(payload, requeueOptionsFor(payload));
    return { descriptor, outcome: 'processed' };
  } catch (err) {
    return {
      descriptor,
      outcome: 'failed',
      reason: (err as Error)?.message ?? 'Unknown error',
    };
  }
}

/** Delete one DLQ entry, containing its own failure. */
async function deleteOne(job: DlqJobLike): Promise<DlqJobResult> {
  const descriptor = describeDlqJob(job);

  try {
    await job.remove();
    return { descriptor, outcome: 'processed' };
  } catch (err) {
    return {
      descriptor,
      outcome: 'failed',
      reason: (err as Error)?.message ?? 'Unknown error',
    };
  }
}

export async function getQueueMetrics(): Promise<{
  waiting: number;
  active: number;
  completed: number;
  failed: number;
  delayed: number;
}> {
  await requireAdmin();

  if (isMockMode()) {
    return {
      waiting: 2,
      active: 1,
      completed: 15,
      failed: 0,
      delayed: 0,
    };
  }

  const counts = await webhookQueue.getJobCounts('waiting', 'active', 'completed', 'failed', 'delayed');
  const dlqCounts = await webhookDLQ.getJobCounts('waiting');

  return {
    waiting: counts.waiting || 0,
    active: counts.active || 0,
    completed: counts.completed || 0,
    failed: dlqCounts.waiting || 0,
    delayed: counts.delayed || 0,
  };
}

export type QueueJobState = "waiting" | "active" | "completed" | "delayed";

export async function getQueueJobs(state: QueueJobState, limit = 200) {
  await requireAdmin();

  // `getQueueMetrics` and `getDLQJobs` both had a mock-mode branch and this did
  // not, so with NEXT_PUBLIC_MOCK_DB set the page rendered its metrics and then
  // threw the moment the jobs table opened, reaching for a Redis connection
  // that was never configured.
  if (isMockMode()) return [];

  const bounded = Math.min(Math.max(limit, 1), DLQ_READ_LIMIT);
  const jobs = await webhookQueue.getJobs([state], 0, bounded - 1);

  return jobs.map((job) => ({
    id: job.id!,
    name: job.name,
    data: job.data,
    timestamp: job.timestamp,
    processedOn: job.processedOn ?? null,
    finishedOn: job.finishedOn ?? null,
    progress: job.progress ?? null,
    attemptsMade: job.attemptsMade ?? 0,
    failedReason: (job as any).failedReason ?? null,
  }));
}

export async function removeQueueJob(jobId: string, state: QueueJobState) {
  await requireAdmin();

  if (state === "active") {
    throw new Error("Cannot remove a job that is currently being processed");
  }

  if (isMockMode()) {
    revalidatePath("/admin/queue");
    return { success: true };
  }

  const job = await webhookQueue.getJob(jobId);
  if (!job) {
    throw new Error("Job not found");
  }

  await job.remove();

  revalidatePath("/admin/queue");
  return { success: true };
}

export async function getDLQJobs() {
  await requireAdmin();

  if (isMockMode()) {
    return [
      {
        id: "mock-dlq-1",
        name: "process-webhook-dlq",
        data: {
          originalJobId: "mock-job-999",
          failedReason: "GitHub API rate limit exceeded after 3 attempts",
          failedAt: new Date(Date.now() - 120000).toISOString(),
          attemptsMade: 3,
          data: {
            event: "pull_request",
            deliveryId: "e2e-mock-delivery-001",
            payload: {
              action: "opened",
              pull_request: {
                id: 9991,
                number: 77,
                title: "Mock PR: E2E DLQ Test",
                state: "open",
                head: { sha: "abc123def456" },
                user: { login: "tokyo_coder" },
              },
              repository: {
                id: 123456,
                full_name: "mock-owner/mock-repo",
                name: "mock-repo",
                owner: { login: "mock-owner" },
              },
              installation: { id: 888999 },
            },
          },
        },
        timestamp: Date.now() - 120000,
      },
      {
        id: "mock-dlq-2",
        name: "process-webhook-dlq",
        data: {
          originalJobId: "mock-job-998",
          failedReason: "Invalid payload structure: missing pull_request field",
          failedAt: new Date(Date.now() - 3600000).toISOString(),
          attemptsMade: 3,
          data: {
            event: "push",
            deliveryId: "e2e-mock-delivery-002",
            payload: {
              action: "push",
              repository: {
                id: 654321,
                full_name: "mock-owner/another-repo",
                name: "another-repo",
                owner: { login: "mock-owner" },
              },
            },
          },
        },
        timestamp: Date.now() - 3600000,
      },
    ];
  }

  const { jobs } = await readDlqJobs();
  return jobs.map((job: any) => ({
    id: job.id!,
    name: job.name,
    data: job.data,
    timestamp: job.timestamp,
  }));
}

export async function requeueDLQJob(jobId: string) {
  const session = await requireAdmin();

  if (isMockMode()) {
    return { success: true };
  }

  const job = (await webhookDLQ.getJob(jobId)) as DlqJobLike | null;
  if (!job) {
    throw new Error("Job not found in DLQ");
  }

  const outcome = await requeueOne(job);

  if (outcome.outcome !== 'processed') {
    throw new Error(outcome.reason ?? 'Failed to requeue job');
  }

  const result = summarizeDlqResults([outcome]);
  await recordDlqAudit(session?.user?.id ?? null, 'DLQ_REQUEUE', result, { scope: 'single' });

  revalidatePath('/admin/queue');
  return { success: true };
}

export async function deleteDLQJob(jobId: string) {
  const session = await requireAdmin();

  if (isMockMode()) {
    return { success: true };
  }

  const job = (await webhookDLQ.getJob(jobId)) as DlqJobLike | null;
  if (!job) {
    throw new Error("Job not found in DLQ");
  }

  const outcome = await deleteOne(job);

  if (outcome.outcome !== 'processed') {
    throw new Error(outcome.reason ?? 'Failed to delete job');
  }

  const result = summarizeDlqResults([outcome]);
  await recordDlqAudit(session?.user?.id ?? null, 'DLQ_DELETE', result, { scope: 'single' });

  revalidatePath('/admin/queue');
  return { success: true };
}

export async function clearAllDLQ(): Promise<BulkDlqResult & { summary: string }> {
  const session = await requireAdmin();

  if (isMockMode()) {
    const empty = summarizeDlqResults([]);
    return { ...empty, summary: describeBulkOutcome(empty, 'Deleted') };
  }

  const { jobs, truncated } = await readDlqJobs();

  // Sequential rather than Promise.all: this is an operator action against a
  // shared Redis connection, and finishing slightly slower is a better trade
  // than a burst of a thousand concurrent removals. Each result is contained,
  // so one bad entry no longer aborts the rest — the old loop threw and left
  // the operator with no idea how far it had got.
  const results: DlqJobResult[] = [];
  for (const job of jobs) {
    results.push(await deleteOne(job));
  }

  const result = summarizeDlqResults(results, truncated);
  await recordDlqAudit(session?.user?.id ?? null, 'DLQ_CLEAR_ALL', result, { scope: 'all' });

  revalidatePath('/admin/queue');
  return { ...result, summary: describeBulkOutcome(result, 'Deleted') };
}

export async function requeueAllDLQ(): Promise<BulkDlqResult & { summary: string }> {
  const session = await requireAdmin();

  if (isMockMode()) {
    const empty = summarizeDlqResults([]);
    return { ...empty, summary: describeBulkOutcome(empty, 'Requeued') };
  }

  const { jobs, truncated } = await readDlqJobs();

  const results: DlqJobResult[] = [];
  for (const job of jobs) {
    results.push(await requeueOne(job));
  }

  const result = summarizeDlqResults(results, truncated);
  await recordDlqAudit(session?.user?.id ?? null, 'DLQ_REQUEUE_ALL', result, { scope: 'all' });

  revalidatePath('/admin/queue');
  return { ...result, summary: describeBulkOutcome(result, 'Requeued') };
}

export async function requeueBulkDLQJobs(
  jobIds: string[]
): Promise<BulkDlqResult & { summary: string }> {
  const session = await requireAdmin();

  if (!jobIds || jobIds.length === 0) {
    const empty = summarizeDlqResults([]);
    return { ...empty, summary: describeBulkOutcome(empty, 'Requeued') };
  }

  if (isMockMode()) {
    const mocked = summarizeDlqResults(
      jobIds.map((id) => ({
        descriptor: { jobId: id, originalJobId: null, deliveryId: null, event: null },
        outcome: 'processed' as const,
      }))
    );
    return { ...mocked, summary: describeBulkOutcome(mocked, 'Requeued') };
  }

  const results: DlqJobResult[] = [];
  for (const id of jobIds) {
    const job = (await webhookDLQ.getJob(id)) as DlqJobLike | null;

    if (!job) {
      results.push({
        descriptor: { jobId: id, originalJobId: null, deliveryId: null, event: null },
        outcome: 'missing',
        reason: 'No longer in the DLQ',
      });
      continue;
    }

    results.push(await requeueOne(job));
  }

  const result = summarizeDlqResults(results);
  await recordDlqAudit(session?.user?.id ?? null, 'DLQ_REQUEUE_BULK', result, {
    scope: 'bulk',
    requested: jobIds.length,
  });

  revalidatePath('/admin/queue');
  return { ...result, summary: describeBulkOutcome(result, 'Requeued') };
}

export async function deleteBulkDLQJobs(
  jobIds: string[]
): Promise<BulkDlqResult & { summary: string }> {
  const session = await requireAdmin();

  if (!jobIds || jobIds.length === 0) {
    const empty = summarizeDlqResults([]);
    return { ...empty, summary: describeBulkOutcome(empty, 'Deleted') };
  }

  if (isMockMode()) {
    const mocked = summarizeDlqResults(
      jobIds.map((id) => ({
        descriptor: { jobId: id, originalJobId: null, deliveryId: null, event: null },
        outcome: 'processed' as const,
      }))
    );
    return { ...mocked, summary: describeBulkOutcome(mocked, 'Deleted') };
  }

  const results: DlqJobResult[] = [];
  for (const id of jobIds) {
    const job = (await webhookDLQ.getJob(id)) as DlqJobLike | null;

    if (!job) {
      results.push({
        descriptor: { jobId: id, originalJobId: null, deliveryId: null, event: null },
        outcome: 'missing',
        reason: 'No longer in the DLQ',
      });
      continue;
    }

    results.push(await deleteOne(job));
  }

  const result = summarizeDlqResults(results);
  await recordDlqAudit(session?.user?.id ?? null, 'DLQ_DELETE_BULK', result, {
    scope: 'bulk',
    requested: jobIds.length,
  });

  revalidatePath('/admin/queue');
  return { ...result, summary: describeBulkOutcome(result, 'Deleted') };
}
