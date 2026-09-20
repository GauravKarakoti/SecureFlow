/**
 * Automated DLQ Retry Worker (#893)
 *
 * Polls `github-webhooks-dlq` on a fixed interval and re-fires eligible jobs
 * back to the main `github-webhooks` queue using exponential backoff scheduling.
 *
 * Design decisions:
 *  - Retry eligibility is determined by `nextRetryAt`, stored in the BullMQ job
 *    data. Jobs whose timestamp has not elapsed are skipped this cycle.
 *  - Exponential backoff: delay = BASE_DELAY_MS * 2^attemptsMade, capped at
 *    MAX_DELAY_MS. This mirrors the BullMQ backoff already on the main queue but
 *    operates at the DLQ level for jobs that exhausted their BullMQ attempts.
 *  - Idempotency is preserved: `requeueOptionsFor` derives the same delivery-id-
 *    keyed `jobId` that the ingest route uses, so BullMQ deduplicates a re-fired
 *    job against any live copy.
 *  - A job that exceeds MAX_AUTO_RETRY_ATTEMPTS is left in the DLQ untouched so
 *    an operator can inspect and manually clear it.
 */

import { webhookDLQ, addWebhookJob } from "./webhookQueue";
import { extractWebhookPayload, requeueOptionsFor, describeDlqJob, type DlqJobLike } from "./dlq";
import { createLogger } from "@/lib/logger";

const log = createLogger({ context: { component: "dlq-auto-retry" } });

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

/** Polling interval in milliseconds. */
export const POLL_INTERVAL_MS = 30_000;

/** Base delay for the first auto-retry (after BullMQ attempts are exhausted). */
export const BASE_DELAY_MS = 5_000;

/** Hard cap on computed backoff delay. */
export const MAX_DELAY_MS = 10 * 60 * 1_000; // 10 minutes

/**
 * Maximum number of automated retry attempts before a job is left for manual
 * operator review. Kept intentionally low: if a job has failed this many times
 * it likely needs human attention, not another automated pass.
 */
export const MAX_AUTO_RETRY_ATTEMPTS = 5;

// ---------------------------------------------------------------------------
// Backoff helpers
// ---------------------------------------------------------------------------

/**
 * Compute the next retry timestamp for a job.
 *
 * `attemptsMade` is the count of BullMQ-level attempts already made; the auto-
 * retry layer adds its own counter on top via `autoRetryCount` in the job data.
 */
export function computeNextRetryAt(autoRetryCount: number): Date {
  const delayMs = Math.min(BASE_DELAY_MS * Math.pow(2, autoRetryCount), MAX_DELAY_MS);
  return new Date(Date.now() + delayMs);
}

/**
 * The auto-retry fields for a DLQ entry written when a job fails permanently.
 *
 * Empty for a job the auto-retry worker never requeued, so a first failure is
 * retried on the next poll as before. A job it did requeue carries its count,
 * and the entry is scheduled with backoff and eventually left for an operator.
 */
export function dlqRetryStateFor(
  dlqAutoRetryCount: unknown,
): Pick<DlqAutoRetryJobData, "autoRetryCount" | "nextRetryAt"> {
  if (typeof dlqAutoRetryCount !== "number" || !Number.isInteger(dlqAutoRetryCount)) return {};
  if (dlqAutoRetryCount <= 0) return {};

  return {
    autoRetryCount: dlqAutoRetryCount,
    nextRetryAt: computeNextRetryAt(dlqAutoRetryCount).toISOString(),
  };
}

/** True when a job's scheduled retry time has elapsed. */
export function isRetryDue(nextRetryAt: string | null | undefined): boolean {
  if (!nextRetryAt) return true; // no schedule set → eligible immediately
  return new Date(nextRetryAt) <= new Date();
}

// ---------------------------------------------------------------------------
// Per-job retry logic
// ---------------------------------------------------------------------------

export interface DlqAutoRetryJobData {
  originalJobId?: string | null;
  data?: unknown;
  failedReason?: string | null;
  failedAt?: string | null;
  attemptsMade?: number | null;
  /** Number of automated retry attempts made by this worker (not BullMQ). */
  autoRetryCount?: number;
  /** ISO timestamp after which this job is eligible for the next retry. */
  nextRetryAt?: string | null;
}

export interface RetryOutcome {
  jobId: string | null | undefined;
  result: "requeued" | "skipped_not_due" | "skipped_max_attempts" | "skipped_no_payload" | "failed";
  reason?: string;
}

/**
 * Attempt to auto-retry one DLQ job.
 *
 * Mutates the job in-place by removing it and re-adding it with updated
 * `autoRetryCount` and `nextRetryAt` metadata when the retry is deferred, or
 * by moving it to the main queue when it is due.
 */
export async function retryDlqJob(job: DlqJobLike): Promise<RetryOutcome> {
  const descriptor = describeDlqJob(job);
  const data = job.data as DlqAutoRetryJobData | null | undefined;
  const autoRetryCount = data?.autoRetryCount ?? 0;

  if (autoRetryCount >= MAX_AUTO_RETRY_ATTEMPTS) {
    return {
      jobId: descriptor.jobId,
      result: "skipped_max_attempts",
      reason: `Exceeded max auto-retry attempts (${MAX_AUTO_RETRY_ATTEMPTS})`,
    };
  }

  if (!isRetryDue(data?.nextRetryAt)) {
    return { jobId: descriptor.jobId, result: "skipped_not_due" };
  }

  const payload = extractWebhookPayload(data);
  if (!payload) {
    return {
      jobId: descriptor.jobId,
      result: "skipped_no_payload",
      reason: "DLQ entry carries no usable webhook payload",
    };
  }

  let removed = false;

  try {
    // Remove from DLQ first — worst case is a lost retry the operator can
    // observe, rather than a duplicate in both queues.
    await job.remove();
    removed = true;
    // The count rides on the job so a re-failure lands back in the DLQ with it
    // (see the worker's `failed` handler); otherwise it restarts at 0 and the
    // limit below is never reached.
    await addWebhookJob(
      { ...payload, dlqAutoRetryCount: autoRetryCount + 1 },
      requeueOptionsFor(payload),
    );

    return { jobId: descriptor.jobId, result: "requeued" };
  } catch (err) {
    if (!removed) {
      // The entry is still in the DLQ; re-inserting would duplicate it.
      return {
        jobId: descriptor.jobId,
        result: "failed",
        reason: err instanceof Error ? err.message : String(err),
      };
    }

    // Re-insert with incremented counter and a deferred `nextRetryAt` so the
    // job is not picked up again immediately.
    const nextCount = autoRetryCount + 1;
    const nextRetryAt = computeNextRetryAt(nextCount).toISOString();

    try {
      await webhookDLQ.add(
        "process-webhook-dlq",
        {
          ...(data ?? {}),
          autoRetryCount: nextCount,
          nextRetryAt,
        },
        { attempts: 1 },
      );
    } catch (reinsertErr) {
      log.error("[DLQ Worker] Failed to re-insert job after retry error", {
        jobId: descriptor.jobId,
        reason: reinsertErr instanceof Error ? reinsertErr.message : String(reinsertErr),
      });
    }

    return {
      jobId: descriptor.jobId,
      result: "failed",
      reason: err instanceof Error ? err.message : String(err),
    };
  }
}

// ---------------------------------------------------------------------------
// Polling loop
// ---------------------------------------------------------------------------

export interface DlqAutoRetryWorkerOptions {
  pollIntervalMs?: number;
}

export interface DlqAutoRetryWorker {
  start(): void;
  stop(): Promise<void>;
}

/**
 * Create and return a DLQ auto-retry worker.
 *
 * The worker polls `github-webhooks-dlq` every `pollIntervalMs` milliseconds
 * and attempts to re-fire eligible jobs. It is intentionally separate from the
 * BullMQ `Worker` abstraction: the DLQ queue has no processor attached — it is
 * a holding area — so a polling loop is the right primitive here.
 */
export function createDlqAutoRetryWorker(
  options: DlqAutoRetryWorkerOptions = {},
): DlqAutoRetryWorker {
  const pollIntervalMs = options.pollIntervalMs ?? POLL_INTERVAL_MS;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let running = false;

  async function poll(): Promise<void> {
    if (!running) return;

    log.info("[DLQ Worker] Polling DLQ for retryable jobs");

    let jobs: DlqJobLike[];
    try {
      jobs = ((await webhookDLQ.getJobs(["waiting"], 0, 999)) ?? []) as DlqJobLike[];
    } catch (err) {
      log.error("[DLQ Worker] Failed to read DLQ", {
        reason: err instanceof Error ? err.message : String(err),
      });
      scheduleNext();
      return;
    }

    if (jobs.length === 0) {
      log.debug("[DLQ Worker] DLQ is empty, nothing to retry");
      scheduleNext();
      return;
    }

    log.info("[DLQ Worker] Found jobs in DLQ", { count: jobs.length });

    let requeued = 0;
    let skipped = 0;
    let failed = 0;

    for (const job of jobs) {
      const outcome = await retryDlqJob(job);

      switch (outcome.result) {
        case "requeued":
          requeued++;
          log.info("[DLQ Worker] Job requeued", { jobId: outcome.jobId });
          break;
        case "skipped_not_due":
          skipped++;
          break;
        case "skipped_max_attempts":
          skipped++;
          log.warn("[DLQ Worker] Job exceeded max auto-retry attempts, leaving for manual review", {
            jobId: outcome.jobId,
            reason: outcome.reason,
          });
          break;
        case "skipped_no_payload":
          skipped++;
          log.warn("[DLQ Worker] Job has no usable payload, skipping", {
            jobId: outcome.jobId,
            reason: outcome.reason,
          });
          break;
        case "failed":
          failed++;
          log.error("[DLQ Worker] Retry attempt failed", {
            jobId: outcome.jobId,
            reason: outcome.reason,
          });
          break;
      }
    }

    log.info("[DLQ Worker] Poll cycle complete", { requeued, skipped, failed });
    scheduleNext();
  }

  function scheduleNext(): void {
    if (!running) return;
    timer = setTimeout(() => void poll(), pollIntervalMs);
  }

  return {
    start(): void {
      if (running) return;
      running = true;
      log.info("[DLQ Worker] Auto-retry worker started", { pollIntervalMs });
      void poll();
    },

    async stop(): Promise<void> {
      running = false;
      if (timer !== null) {
        clearTimeout(timer);
        timer = null;
      }
      log.info("[DLQ Worker] Auto-retry worker stopped");
    },
  };
}
