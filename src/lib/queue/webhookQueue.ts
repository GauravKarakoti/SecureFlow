import { Queue } from 'bullmq';
import { redis } from './redis';

export const webhookQueue = new Queue('github-webhooks', {
  connection: redis as any,
});

export async function addWebhookJob(payload: any) {
  return await webhookQueue.add('process-webhook', payload, {
    attempts: 3,
    backoff: { type: 'exponential', delay: 5000 },
  });
}
