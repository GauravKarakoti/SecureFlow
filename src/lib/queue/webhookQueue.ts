import { Queue } from "bullmq";
import { redis } from "./redis";

export interface WebhookJobData {
  payload?: Record<string, unknown>;
  event?: string | null;
  deliveryId?: string | null;
  /**
   * How many times the DLQ auto-retry worker has requeued this delivery.
   *
   * Carried on the job so that, if it fails again, the worker's `failed`
   * handler can write the count back onto the new DLQ entry. Without it every
   * re-failure arrived in the DLQ as a first-time entry, so the auto-retry
   * limit and backoff never applied.
   */
  dlqAutoRetryCount?: number;
}

/**
 * How long BullMQ keeps a finished job, in seconds.
 *
 * This was unset, which BullMQ reads as "forever", and it is the only queue here
 * that was left that way (`scanQueue` and `sbomQueue` both set these). Every
 * delivery's job carries its full webhook payload, so Redis grew by one payload
 * per webhook for as long as the deployment lived.
 *
 * Neither window is the idempotency guarantee. A *completed* delivery is
 * recorded in the `WebhookEvent` table, which the worker checks before doing
 * anything, so a replay after its job has expired is discarded there. A *failed*
 * delivery has no such record, and its dead job holds the job ID until it is
 * either replaced (`replaceFailed`) or expires here; the DLQ keeps its own copy
 * of the payload for as long as an operator needs it.
 */
export const WEBHOOK_JOB_COMPLETED_RETENTION_SECONDS = 86_400; // 24 hours
export const WEBHOOK_JOB_FAILED_RETENTION_SECONDS = 172_800; // 48 hours

export const webhookQueue = new Queue<WebhookJobData>("github-webhooks", {
  connection: redis as any,
  defaultJobOptions: {
    attempts: 3,
    backoff: {
      type: "exponential",
      delay: 5000,
    },
    removeOnComplete: { age: WEBHOOK_JOB_COMPLETED_RETENTION_SECONDS },
    removeOnFail: { age: WEBHOOK_JOB_FAILED_RETENTION_SECONDS },
  },
});

export const webhookDLQ = new Queue("github-webhooks-dlq", {
  connection: redis as any,
});

export interface AddWebhookJobOptions {
  /**
   * Deterministic job ID, normally `delivery:<x-github-delivery>` (#562).
   *
   * BullMQ refuses a job whose ID already exists, so this gives the queue its
   * own dedupe. Without it the worker's `webhookEvent.findUnique` check was the
   * only thing standing between a replayed delivery and a full re-scan — a
   * duplicate would be enqueued, picked up, and only then discarded, having
   * already occupied a worker slot.
   */
  jobId?: string;
  /**
   * Replace a *failed* job that already holds `jobId`, instead of deduping
   * against it. Set by the DLQ requeue paths and by the webhook ingest route.
   *
   * The main queue keeps failed jobs, so a delivery that exhausted its attempts
   * still owns `delivery-<id>`. BullMQ treats any later attempt to enqueue that
   * delivery as a duplicate of the dead job and returns it without adding
   * anything. For a DLQ requeue that means the entry is already gone and the
   * webhook never runs again. For ingest it means GitHub's "Redeliver" button,
   * which reuses the original delivery ID, is answered `202 queued` and does
   * nothing — and since the ingest route answers before the job runs, GitHub
   * never lists such a delivery as failed in the first place, so redelivering by
   * hand is the only remedy an operator has.
   *
   * A job in any other state is a live or finished copy, and deduping against
   * it is still correct.
   */
  replaceFailed?: boolean;
}

export async function addWebhookJob(payload: WebhookJobData, options: AddWebhookJobOptions = {}) {
  if (process.env.NEXT_PUBLIC_MOCK_DB === "true") {
    return {
      id: options.jobId ?? `mock-job-${Date.now()}`,
      name: "process-webhook",
      data: payload,
    };
  }
  if (options.jobId && options.replaceFailed) {
    const existing = await webhookQueue.getJob(options.jobId);
    if (existing && (await existing.getState()) === "failed") {
      await existing.remove();
    }
  }
  return await webhookQueue.add("process-webhook", payload, {
    attempts: 3,
    backoff: { type: "exponential", delay: 5000 },
    ...(options.jobId ? { jobId: options.jobId } : {}),
  });
}
