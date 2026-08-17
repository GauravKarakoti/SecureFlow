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

export async function addWebhookJob(payload: WebhookJobData) {
  if (process.env.NEXT_PUBLIC_MOCK_DB === 'true') {
    return { id: `mock-job-${Date.now()}`, name: 'process-webhook', data: payload };
  }
  return await webhookQueue.add('process-webhook', payload, {
    attempts: 3,
    backoff: { type: 'exponential', delay: 5000 },
  });
}
