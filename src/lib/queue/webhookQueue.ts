import { Queue } from 'bullmq';
import { redis } from './redis';

export const webhookQueue = new Queue('github-webhooks', {
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

export async function addWebhookJob(payload: any) {
  return await webhookQueue.add('process-webhook', payload, {
    attempts: 3,
    backoff: { type: 'exponential', delay: 5000 },
  });
}
