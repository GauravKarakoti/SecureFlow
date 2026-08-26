import { describe, it, expect } from 'vitest';
import {
  AUDIT_SAMPLE_SIZE,
  DLQ_READ_LIMIT,
  auditSample,
  deliveryIdOf,
  describeBulkOutcome,
  describeDlqJob,
  extractWebhookPayload,
  requeueOptionsFor,
  summarizeDlqResults,
  type DlqJobResult,
} from './dlq';
import { webhookJobId } from '@/lib/github/webhook-verification';

/** A DLQ entry in the shape the worker's `failed` handler writes. */
function dlqEntry(payload: unknown, overrides: Record<string, unknown> = {}) {
  return {
    originalJobId: 'job-1',
    data: payload,
    failedReason: 'boom',
    failedAt: '2026-01-01T00:00:00.000Z',
    attemptsMade: 3,
    ...overrides,
  };
}

function result(outcome: DlqJobResult['outcome'], deliveryId: string | null = null): DlqJobResult {
  return {
    descriptor: { jobId: 'j', originalJobId: 'o', deliveryId, event: null },
    outcome,
  };
}

describe('extractWebhookPayload (#656)', () => {
  it('returns the original payload from a well-formed DLQ entry', () => {
    const payload = { event: 'pull_request', deliveryId: 'abc-123', payload: { action: 'opened' } };

    expect(extractWebhookPayload(dlqEntry(payload))).toEqual(payload);
  });

  it('accepts an entry carrying only one of the three known fields', () => {
    expect(extractWebhookPayload(dlqEntry({ event: 'push' }))).toEqual({ event: 'push' });
    expect(extractWebhookPayload(dlqEntry({ deliveryId: 'd' }))).toEqual({ deliveryId: 'd' });
    expect(extractWebhookPayload(dlqEntry({ payload: {} }))).toEqual({ payload: {} });
  });

  it('returns null when the entry has no data at all', () => {
    // This is the case that used to produce addWebhookJob(undefined): a job the
    // worker cannot process, which fails three more times and lands back here.
    expect(extractWebhookPayload(dlqEntry(undefined))).toBeNull();
    expect(extractWebhookPayload(dlqEntry(null))).toBeNull();
    expect(extractWebhookPayload(null)).toBeNull();
    expect(extractWebhookPayload(undefined)).toBeNull();
  });

  it('rejects a payload that is not a plain object', () => {
    expect(extractWebhookPayload(dlqEntry('a string'))).toBeNull();
    expect(extractWebhookPayload(dlqEntry(42))).toBeNull();
    expect(extractWebhookPayload(dlqEntry([{ event: 'push' }]))).toBeNull();
  });

  it('rejects an object carrying none of the known fields', () => {
    expect(extractWebhookPayload(dlqEntry({ unrelated: true }))).toBeNull();
  });
});

describe('deliveryIdOf (#656)', () => {
  it('normalises the delivery id from the payload', () => {
    expect(deliveryIdOf({ deliveryId: '  abc-123  ' })).toBe('abc-123');
  });

  it('rejects a delivery id that would not be a safe job key', () => {
    expect(deliveryIdOf({ deliveryId: 'has spaces' })).toBeNull();
    expect(deliveryIdOf({ deliveryId: 'a'.repeat(201) })).toBeNull();
    expect(deliveryIdOf({ deliveryId: '' })).toBeNull();
    expect(deliveryIdOf({})).toBeNull();
    expect(deliveryIdOf(null)).toBeNull();
  });
});

describe('requeueOptionsFor (#656)', () => {
  it('reuses the same jobId the ingest route enqueues with', () => {
    // This is the regression that mattered: /api/webhooks/github enqueues with
    // { jobId: webhookJobId(deliveryId) } so BullMQ refuses a duplicate, and
    // the requeue paths passed no options at all.
    const options = requeueOptionsFor({ deliveryId: 'delivery-abc', event: 'push' });

    expect(options).toEqual({ jobId: webhookJobId('delivery-abc') });
  });

  it('produces a stable id, so requeue and a GitHub redelivery collapse to one job', () => {
    const first = requeueOptionsFor({ deliveryId: 'same-id' });
    const second = requeueOptionsFor({ deliveryId: 'same-id', event: 'pull_request' });

    expect(first.jobId).toBe(second.jobId);
  });

  it('still requeues, without the guarantee, when no delivery id survives', () => {
    expect(requeueOptionsFor({ event: 'push' })).toEqual({});
    expect(requeueOptionsFor({ deliveryId: 'not valid' })).toEqual({});
    expect(requeueOptionsFor(null)).toEqual({});
  });
});

describe('describeDlqJob (#656)', () => {
  it('pulls identifiers out without touching the payload body', () => {
    const job = {
      id: 'dlq-7',
      data: dlqEntry(
        { event: 'pull_request', deliveryId: 'del-9', payload: { secret: 'do-not-copy' } },
        { originalJobId: 'orig-2' }
      ),
      remove: async () => undefined,
    };

    const descriptor = describeDlqJob(job);

    expect(descriptor).toEqual({
      jobId: 'dlq-7',
      originalJobId: 'orig-2',
      deliveryId: 'del-9',
      event: 'pull_request',
    });
    expect(JSON.stringify(descriptor)).not.toContain('do-not-copy');
  });

  it('degrades to nulls rather than throwing on a malformed entry', () => {
    const descriptor = describeDlqJob({ id: null, data: null, remove: async () => undefined });

    expect(descriptor).toEqual({
      jobId: null,
      originalJobId: null,
      deliveryId: null,
      event: null,
    });
  });

  it('ignores a non-string event', () => {
    const job = {
      id: 'x',
      data: dlqEntry({ event: 42, deliveryId: 'd' }),
      remove: async () => undefined,
    };

    expect(describeDlqJob(job).event).toBeNull();
  });
});

describe('summarizeDlqResults (#656)', () => {
  it('counts each outcome separately', () => {
    const summary = summarizeDlqResults([
      result('processed'),
      result('processed'),
      result('skipped'),
      result('failed'),
      result('missing'),
    ]);

    expect(summary).toMatchObject({
      success: true,
      count: 2,
      skipped: 1,
      failed: 1,
      missing: 1,
      truncated: false,
    });
  });

  it('reports an empty batch without inventing a success count', () => {
    expect(summarizeDlqResults([])).toMatchObject({ count: 0, skipped: 0, failed: 0, missing: 0 });
  });

  it('carries the truncation flag through', () => {
    expect(summarizeDlqResults([result('processed')], true).truncated).toBe(true);
  });
});

describe('describeBulkOutcome (#656)', () => {
  it('says only the count when everything succeeded', () => {
    const summary = summarizeDlqResults([result('processed'), result('processed')]);

    expect(describeBulkOutcome(summary, 'Requeued')).toBe('Requeued 2 jobs');
  });

  it('uses the singular for one job', () => {
    expect(describeBulkOutcome(summarizeDlqResults([result('processed')]), 'Deleted')).toBe(
      'Deleted 1 job'
    );
  });

  it('names every category that was left behind', () => {
    const summary = summarizeDlqResults(
      [result('processed'), result('skipped'), result('failed'), result('missing')],
      true
    );

    const text = describeBulkOutcome(summary, 'Requeued');

    expect(text).toContain('Requeued 1 job');
    expect(text).toContain('1 skipped (no usable payload)');
    expect(text).toContain('1 failed');
    expect(text).toContain('1 no longer in the queue');
    expect(text).toContain(`stopped at the ${DLQ_READ_LIMIT}-job read limit`);
  });
});

describe('auditSample (#656)', () => {
  it('lists only the entries that were actually processed', () => {
    const sample = auditSample([
      result('processed', 'del-1'),
      result('skipped', 'del-2'),
      result('processed', 'del-3'),
    ]);

    expect(sample).toEqual(['del-1', 'del-3']);
  });

  it('falls back to the job identifiers when there is no delivery id', () => {
    expect(auditSample([result('processed', null)])).toEqual(['o']);
  });

  it('is bounded, so clearing a large DLQ cannot write one row per entry', () => {
    const many = Array.from({ length: AUDIT_SAMPLE_SIZE + 25 }, (_, i) =>
      result('processed', `del-${i}`)
    );

    expect(auditSample(many)).toHaveLength(AUDIT_SAMPLE_SIZE);
  });
});
