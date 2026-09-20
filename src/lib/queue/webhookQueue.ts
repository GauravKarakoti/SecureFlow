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

export const webhookQueue = new Queue<WebhookJobData>("github-webhooks", {
  connection: redis as any,
  defaultJobOptions: {
    attempts: 3,
    backoff: {
      type: "exponential",
      delay: 5000,
    },
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
   * against it. Set by the DLQ requeue paths.
   *
   * The main queue keeps failed jobs, so a delivery that exhausted its attempts
   * still owns `delivery-<id>` when its DLQ entry is requeued. BullMQ treats
   * the requeue as a duplicate of that dead job and returns it without adding
   * anything: the DLQ entry is already gone and the webhook never runs again.
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
