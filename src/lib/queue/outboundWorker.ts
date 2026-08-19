import { Worker, Job } from 'bullmq';
import { redis } from './redis';
import { outboundWebhookDLQ, OutboundWebhookData } from './outboundWebhookQueue';
import { createHmac } from 'crypto';

// Sanitize user-controlled strings before logging
const sanitize = (s: unknown) => String(s ?? '').replace(/[\r\n]/g, ' ');

export const outboundWorker = new Worker<OutboundWebhookData>('outbound-webhooks', async (job: Job<OutboundWebhookData>) => {
  const { url, payload, secret } = job.data;
  
  const payloadString = typeof payload === 'string' ? payload : JSON.stringify(payload);
  
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  };

  if (secret) {
    const signature = createHmac('sha256', secret).update(payloadString).digest('hex');
    headers['X-SecureFlow-Signature'] = signature;
  }

  console.log(`[OutboundWorker] Dispatching webhook to ${sanitize(url)}`);
  
  const response = await fetch(url, {
    method: 'POST',
    headers,
    body: payloadString,
  });

  if (!response.ok) {
    throw new Error(`Failed to dispatch webhook. HTTP Status: ${response.status} ${response.statusText}`);
  }

  console.log(`[OutboundWorker] Successfully dispatched webhook to ${sanitize(url)}`);
}, { connection: redis as any });

outboundWorker.on('completed', (job: Job) => {
  console.log(`[QUEUE-OUTBOUND] Job ${job.id} completed.`);
});

outboundWorker.on('failed', async (job: Job | undefined, err: Error) => {
  if (!job) return;
  const maxAttempts = job.opts.attempts || 3;
  if (job.attemptsMade >= maxAttempts) {
    console.error(`[DLQ-OUTBOUND] Job ${sanitize(job.id)} failed permanently after ${sanitize(job.attemptsMade)} attempts: ${sanitize(err.message)}`);
    try {
      await outboundWebhookDLQ.add(
        'dispatch-webhook-dlq',
        {
          originalJobId: job.id,
          data: job.data,
          failedReason: err.message,
          failedAt: new Date().toISOString(),
          attemptsMade: job.attemptsMade,
        },
        {
          attempts: 1,
        }
      );
    } catch (dlqErr: any) {
      console.error(`Failed to route job ${sanitize(job.id)} to DLQ:`, sanitize(dlqErr.message));
    }
  } else {
    console.warn(`[QUEUE-OUTBOUND] Job ${sanitize(job.id)} failed (attempt ${sanitize(job.attemptsMade)}/${sanitize(maxAttempts)}), retrying with exponential backoff: ${sanitize(err.message)}`);
  }
});
