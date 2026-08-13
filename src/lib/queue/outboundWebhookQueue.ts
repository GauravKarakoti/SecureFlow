import { Queue } from 'bullmq';
import { redis } from './redis';

export interface OutboundWebhookData {
  url: string;
  payload: Record<string, unknown> | string;
  secret?: string; // Optional secret for HMAC-SHA256 signature if needed
}

export const outboundWebhookQueue = new Queue<OutboundWebhookData>('outbound-webhooks', {
  connection: redis as any,
  defaultJobOptions: {
    attempts: 3,
    backoff: {
      type: 'exponential',
      delay: 5000,
    },
    removeOnComplete: true,
    removeOnFail: 100, // Keep last 100 failed jobs for debugging
  },
});

export const outboundWebhookDLQ = new Queue('outbound-webhooks-dlq', {
  connection: redis as any,
});

export async function enqueueWebhook(data: OutboundWebhookData) {
  if (process.env.NEXT_PUBLIC_MOCK_DB === 'true') {
    return { id: `mock-outbound-${Date.now()}`, name: 'dispatch-webhook', data };
  }
  return await outboundWebhookQueue.add('dispatch-webhook', data);
}
