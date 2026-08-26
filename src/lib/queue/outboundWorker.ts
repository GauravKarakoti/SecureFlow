import { Worker, Job, UnrecoverableError } from 'bullmq';
import { redis } from './redis';
import { outboundWebhookDLQ, OutboundWebhookData } from './outboundWebhookQueue';
import {
  OutboundDeliveryError,
  OutboundDestinationError,
  dispatchOutboundWebhook,
} from './outbound-dispatch';
import { createLogger } from '@/lib/logger';

const log = createLogger({ context: { component: 'outbound-worker' } });

/**
 * Process one outbound delivery.
 *
 * Exported so the behaviour can be tested directly rather than through
 * `(worker as any).processFn`, which reaches into BullMQ internals.
 *
 * The destination checks, the deadline, the redirect policy and the bounded
 * body read all live in `./outbound-dispatch` (#642). What is left here is the
 * queue-shaped decision: which failures deserve another attempt.
 */
export async function processOutboundWebhook(job: Job<OutboundWebhookData>): Promise<void> {
  const { url, payload, secret } = job.data;

  try {
    const result = await dispatchOutboundWebhook({
      url,
      payload,
      secret,
      // The BullMQ job id is already unique and already appears in our logs, so
      // reusing it gives the receiver the same handle we have.
      deliveryId: job.id ? String(job.id) : undefined,
    });

    log.info('Outbound webhook delivered', {
      jobId: job.id,
      // Scheme + host only. Most providers put a token in the path or query
      // string, so the full URL must not reach a log drain.
      destination: result.destination,
      status: result.status,
      durationMs: result.durationMs,
      deliveryId: result.deliveryId,
    });
  } catch (error) {
    // A destination we refuse, or a status that will never succeed, is not worth
    // two more attempts and 15 seconds of backoff. UnrecoverableError tells
    // BullMQ to fail the job immediately, which routes it to the DLQ on the
    // first pass instead of the third.
    const permanent =
      error instanceof OutboundDestinationError ||
      (error instanceof OutboundDeliveryError && !error.retryable);

    const message = error instanceof Error ? error.message : String(error);
    const status = error instanceof OutboundDeliveryError ? error.status : undefined;

    if (permanent) {
      log.error('Outbound webhook permanently rejected', {
        jobId: job.id,
        reason: message,
        status,
      });
      throw new UnrecoverableError(message);
    }

    log.warn('Outbound webhook failed, will retry', {
      jobId: job.id,
      attempt: job.attemptsMade,
      reason: message,
      status,
    });
    throw error instanceof Error ? error : new Error(message);
  }
}

export const outboundWorker = new Worker<OutboundWebhookData>(
  'outbound-webhooks',
  processOutboundWebhook,
  { connection: redis as any }
);

outboundWorker.on('completed', (job: Job) => {
  log.debug('Outbound job completed', { jobId: job.id });
});

outboundWorker.on('failed', async (job: Job | undefined, err: Error) => {
  if (!job) return;

  const maxAttempts = job.opts.attempts || 3;
  // An UnrecoverableError stops the retry chain wherever it happened, so
  // `attemptsMade >= maxAttempts` is no longer the only way a job is finished
  // with. Without this check a permanently-rejected job would leave the queue
  // without ever being recorded in the DLQ, and `/admin/queue` would show
  // nothing at all for a delivery that will never happen.
  const exhausted = job.attemptsMade >= maxAttempts;
  const unrecoverable = err.name === 'UnrecoverableError';

  if (!exhausted && !unrecoverable) {
    log.warn('Outbound job failed, retrying with exponential backoff', {
      jobId: job.id,
      attempt: job.attemptsMade,
      maxAttempts,
      reason: err.message,
    });
    return;
  }

  log.error('Outbound job failed permanently', {
    jobId: job.id,
    attempts: job.attemptsMade,
    unrecoverable,
    reason: err.message,
  });

  try {
    await outboundWebhookDLQ.add(
      'dispatch-webhook-dlq',
      {
        originalJobId: job.id,
        data: job.data,
        failedReason: err.message,
        failedAt: new Date().toISOString(),
        attemptsMade: job.attemptsMade,
        unrecoverable,
      },
      { attempts: 1 }
    );
  } catch (dlqErr) {
    log.error('Failed to route outbound job to DLQ', {
      jobId: job.id,
      reason: dlqErr instanceof Error ? dlqErr.message : String(dlqErr),
    });
  }
});
