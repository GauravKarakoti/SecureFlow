import { Queue } from 'bullmq';
import { redis } from './redis';

export interface WebhookJobData {
  payload?: Record<string, unknown>;
  event?: string | null;
  deliveryId?: string | null;
}

export const webhookQueue = new Queue<WebhookJobData>('github-webhooks', {
  connection: redis as any,
  defaultJobOptions: {
    attempts: 3,
    backoff: {
      type: 'exponential',
      delay: 5000,
    },
  },
});

export const webhookDLQ = new Queue('github-webhooks-dlq', {
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
}

export async function addWebhookJob(
  payload: WebhookJobData,
  options: AddWebhookJobOptions = {}
) {
  if (process.env.NEXT_PUBLIC_MOCK_DB === 'true') {
    return {
      id: options.jobId ?? `mock-job-${Date.now()}`,
      name: 'process-webhook',
      data: payload,
    };
  }
  return await webhookQueue.add('process-webhook', payload, {
    attempts: 3,
    backoff: { type: 'exponential', delay: 5000 },
    ...(options.jobId ? { jobId: options.jobId } : {}),
  });
}
