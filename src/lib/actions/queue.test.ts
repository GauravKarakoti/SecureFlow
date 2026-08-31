import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  getQueueMetrics,
  getDLQJobs,
  requeueDLQJob,
  deleteDLQJob,
  clearAllDLQ,
  requeueAllDLQ,
  requeueBulkDLQJobs,
  deleteBulkDLQJobs
} from '@/lib/actions/queue';
import { DLQ_READ_LIMIT } from '@/lib/queue/dlq';
import { webhookJobId } from '@/lib/github/webhook-verification';
import { auth } from '@/auth';
import prisma from '@/lib/prisma';
import { revalidatePath } from 'next/cache';

// Mock the dependencies
vi.mock('@/auth', () => ({
  auth: vi.fn(),
}));

vi.mock('next/cache', () => ({
  revalidatePath: vi.fn(),
}));

// The DLQ actions now write an AuditLog entry, which the shared stub in
// vitest.setup.ts does not expose a `create` for.
vi.mock('@/lib/prisma', () => ({
  default: {
    auditLog: { create: vi.fn(async () => ({})) },
  },
}));

// Use vi.hoisted to create the mocks before vi.mock is hoisted
const mockGetJobCounts = vi.hoisted(() => vi.fn());
const mockGetJobCountsDLQ = vi.hoisted(() => vi.fn());
const mockGetJobsDLQ = vi.hoisted(() => vi.fn());
const mockGetJobDLQ = vi.hoisted(() => vi.fn());
const mockAddWebhookJob = vi.hoisted(() => vi.fn());

vi.mock('@/lib/queue/webhookQueue', () => ({
  webhookQueue: {
    getJobCounts: mockGetJobCounts,
  },
  webhookDLQ: {
    getJobCounts: mockGetJobCountsDLQ,
    getJobs: mockGetJobsDLQ,
    getJob: mockGetJobDLQ,
  },
  addWebhookJob: mockAddWebhookJob,
}));

const ADMIN_SESSION = { user: { id: 'admin-1', roles: ['ADMIN'] } };

/** A DLQ job in the shape the worker's `failed` handler writes. */
function dlqJob(id: string, payload: unknown, remove = vi.fn()) {
  return {
    id,
    name: 'process-webhook-dlq',
    timestamp: 1,
    data: {
      originalJobId: `orig-${id}`,
      data: payload,
      failedReason: 'boom',
      failedAt: '2026-01-01T00:00:00.000Z',
      attemptsMade: 3,
    },
    remove,
  };
}

function payloadFor(deliveryId: string) {
  return { event: 'pull_request', deliveryId, payload: { action: 'opened' } };
}

/** The first AuditLog row a DLQ action wrote, if any. */
function auditCall() {
  const create = prisma.auditLog.create as any;
  return create.mock.calls[0]?.[0]?.data;
}

describe('Queue Actions & DLQ', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (auth as any).mockResolvedValue(ADMIN_SESSION);
    (prisma.auditLog.create as any).mockResolvedValue({});
    mockAddWebhookJob.mockResolvedValue({ id: 'queued' });
  });

  describe('getQueueMetrics', () => {
    it('returns combined job counts (failed count overridden by DLQ waiting) for an ADMIN user', async () => {
      mockGetJobCounts.mockResolvedValue({
        waiting: 5,
        active: 2,
        completed: 150,
        failed: 3,
        delayed: 0,
      });

      mockGetJobCountsDLQ.mockResolvedValue({
        waiting: 12,
      });

      const result = await getQueueMetrics();
      expect(result).toEqual({
        waiting: 5,
        active: 2,
        completed: 150,
        failed: 12,
        delayed: 0,
      });
    });

    it('throws Unauthorized for non-admin users', async () => {
      (auth as any).mockResolvedValue({ user: { id: 'user-1', roles: ['USER'] } });

      await expect(getQueueMetrics()).rejects.toThrow('Unauthorized');
    });

    it('throws Unauthorized when there is no session at all', async () => {
      (auth as any).mockResolvedValue(null);

      await expect(getQueueMetrics()).rejects.toThrow('Unauthorized');
    });
  });

  describe('getDLQJobs', () => {
    it('maps DLQ entries to the table shape', async () => {
      mockGetJobsDLQ.mockResolvedValue([dlqJob('dlq-1', payloadFor('del-1'))]);

      const jobs = await getDLQJobs();

      expect(jobs).toHaveLength(1);
      expect(jobs[0]).toMatchObject({ id: 'dlq-1', name: 'process-webhook-dlq' });
    });

    it('bounds the read instead of pulling the whole dead-letter queue', async () => {
      mockGetJobsDLQ.mockResolvedValue([]);

      await getDLQJobs();

      expect(mockGetJobsDLQ).toHaveBeenCalledWith(['waiting'], 0, DLQ_READ_LIMIT);
    });

    it('throws Unauthorized for non-admin users', async () => {
      (auth as any).mockResolvedValue({ user: { id: 'user-1', roles: ['USER'] } });

      await expect(getDLQJobs()).rejects.toThrow('Unauthorized');
    });
  });

  describe('requeueDLQJob', () => {
    it('requeues with the delivery-derived jobId so a redelivery cannot duplicate it', async () => {
      const remove = vi.fn();
      mockGetJobDLQ.mockResolvedValue(dlqJob('dlq-1', payloadFor('del-abc'), remove));

      const result = await requeueDLQJob('dlq-1');

      expect(result).toEqual({ success: true });
      expect(mockAddWebhookJob).toHaveBeenCalledWith(payloadFor('del-abc'), {
        jobId: webhookJobId('del-abc'),
      });
      expect(remove).toHaveBeenCalledOnce();
      expect(revalidatePath).toHaveBeenCalledWith('/admin/queue');
    });

    it('removes from the DLQ before adding, so a failure cannot leave the job in both queues', async () => {
      const order: string[] = [];
      const remove = vi.fn(async () => {
        order.push('remove');
      });
      mockAddWebhookJob.mockImplementation(async () => {
        order.push('add');
      });
      mockGetJobDLQ.mockResolvedValue(dlqJob('dlq-1', payloadFor('del-abc'), remove));

      await requeueDLQJob('dlq-1');

      expect(order).toEqual(['remove', 'add']);
    });

    it('refuses an entry with no usable payload instead of enqueueing undefined', async () => {
      const remove = vi.fn();
      mockGetJobDLQ.mockResolvedValue(dlqJob('dlq-1', undefined, remove));

      await expect(requeueDLQJob('dlq-1')).rejects.toThrow(/no usable webhook payload/);
      expect(mockAddWebhookJob).not.toHaveBeenCalled();
      expect(remove).not.toHaveBeenCalled();
    });

    it('still requeues an entry whose delivery id cannot be recovered', async () => {
      mockGetJobDLQ.mockResolvedValue(dlqJob('dlq-1', { event: 'push' }));

      await requeueDLQJob('dlq-1');

      expect(mockAddWebhookJob).toHaveBeenCalledWith({ event: 'push' }, {});
    });

    it('records the requeue in the audit log', async () => {
      mockGetJobDLQ.mockResolvedValue(dlqJob('dlq-1', payloadFor('del-abc')));

      await requeueDLQJob('dlq-1');

      expect(auditCall()).toMatchObject({
        userId: 'admin-1',
        action: 'DLQ_REQUEUE',
        metadata: expect.objectContaining({ scope: 'single', processed: 1 }),
      });
    });

    it('throws when the job is gone', async () => {
      mockGetJobDLQ.mockResolvedValue(null);

      await expect(requeueDLQJob('missing')).rejects.toThrow('Job not found in DLQ');
    });
  });

  describe('deleteDLQJob', () => {
    it('deletes a DLQ job and records it', async () => {
      const remove = vi.fn();
      mockGetJobDLQ.mockResolvedValue(dlqJob('dlq-2', payloadFor('del-2'), remove));

      const result = await deleteDLQJob('dlq-2');

      expect(result).toEqual({ success: true });
      expect(remove).toHaveBeenCalledOnce();
      expect(auditCall()).toMatchObject({ action: 'DLQ_DELETE' });
      expect(revalidatePath).toHaveBeenCalledWith('/admin/queue');
    });

    it('surfaces the underlying error when the removal fails', async () => {
      mockGetJobDLQ.mockResolvedValue(
        dlqJob('dlq-2', payloadFor('del-2'), vi.fn(async () => {
          throw new Error('redis is down');
        }))
      );

      await expect(deleteDLQJob('dlq-2')).rejects.toThrow('redis is down');
    });
  });

  describe('clearAllDLQ', () => {
    it('removes every job and reports the count', async () => {
      const remove1 = vi.fn();
      const remove2 = vi.fn();
      mockGetJobsDLQ.mockResolvedValue([
        dlqJob('1', payloadFor('del-1'), remove1),
        dlqJob('2', payloadFor('del-2'), remove2),
      ]);

      const result = await clearAllDLQ();

      expect(result).toMatchObject({ success: true, count: 2, failed: 0 });
      expect(result.summary).toBe('Deleted 2 jobs');
      expect(remove1).toHaveBeenCalledOnce();
      expect(remove2).toHaveBeenCalledOnce();
      expect(revalidatePath).toHaveBeenCalledWith('/admin/queue');
    });

    it('keeps going when one removal fails, rather than aborting the batch', async () => {
      const good = vi.fn();
      mockGetJobsDLQ.mockResolvedValue([
        dlqJob('1', payloadFor('del-1'), vi.fn(async () => {
          throw new Error('nope');
        })),
        dlqJob('2', payloadFor('del-2'), good),
      ]);

      const result = await clearAllDLQ();

      expect(result).toMatchObject({ count: 1, failed: 1 });
      expect(good).toHaveBeenCalledOnce();
      expect(result.summary).toContain('1 failed');
    });

    it('records the purge in the audit log with a bounded delivery-id sample', async () => {
      mockGetJobsDLQ.mockResolvedValue([dlqJob('1', payloadFor('del-1'))]);

      await clearAllDLQ();

      expect(auditCall()).toMatchObject({
        userId: 'admin-1',
        action: 'DLQ_CLEAR_ALL',
        metadata: expect.objectContaining({ scope: 'all', deliveryIds: ['del-1'] }),
      });
    });

    it('reports truncation when the read limit stopped it short', async () => {
      mockGetJobsDLQ.mockResolvedValue(
        Array.from({ length: DLQ_READ_LIMIT + 1 }, (_, i) => dlqJob(String(i), payloadFor(`d-${i}`)))
      );

      const result = await clearAllDLQ();

      expect(result.truncated).toBe(true);
      expect(result.count).toBe(DLQ_READ_LIMIT);
      expect(result.summary).toContain('read limit');
    });

    it('does not fail the operation when the audit write throws', async () => {
      (prisma.auditLog.create as any).mockRejectedValueOnce(new Error('audit down'));
      mockGetJobsDLQ.mockResolvedValue([dlqJob('1', payloadFor('del-1'))]);

      await expect(clearAllDLQ()).resolves.toMatchObject({ count: 1 });
    });
  });

  describe('requeueAllDLQ', () => {
    it('requeues every job with its own delivery-derived jobId', async () => {
      mockGetJobsDLQ.mockResolvedValue([
        dlqJob('1', payloadFor('del-1')),
        dlqJob('2', payloadFor('del-2')),
      ]);

      const result = await requeueAllDLQ();

      expect(result).toMatchObject({ success: true, count: 2 });
      expect(mockAddWebhookJob).toHaveBeenNthCalledWith(1, payloadFor('del-1'), {
        jobId: webhookJobId('del-1'),
      });
      expect(mockAddWebhookJob).toHaveBeenNthCalledWith(2, payloadFor('del-2'), {
        jobId: webhookJobId('del-2'),
      });
    });

    it('skips entries with no payload and leaves them in the queue', async () => {
      const badRemove = vi.fn();
      mockGetJobsDLQ.mockResolvedValue([
        dlqJob('1', undefined, badRemove),
        dlqJob('2', payloadFor('del-2')),
      ]);

      const result = await requeueAllDLQ();

      expect(result).toMatchObject({ count: 1, skipped: 1 });
      expect(badRemove).not.toHaveBeenCalled();
      expect(mockAddWebhookJob).toHaveBeenCalledTimes(1);
      expect(result.summary).toContain('no usable payload');
    });

    it('records the replay in the audit log', async () => {
      mockGetJobsDLQ.mockResolvedValue([dlqJob('1', payloadFor('del-1'))]);

      await requeueAllDLQ();

      expect(auditCall()).toMatchObject({ action: 'DLQ_REQUEUE_ALL' });
    });
  });

  describe('requeueBulkDLQJobs', () => {
    it('requeues the selected jobs and reports the count', async () => {
      const job1 = dlqJob('bulk-1', payloadFor('del-1'));
      const job2 = dlqJob('bulk-2', payloadFor('del-2'));

      mockGetJobDLQ.mockImplementation(async (id: string) =>
        (({ 'bulk-1': job1, 'bulk-2': job2 }) as any)[id] ?? null
      );

      const result = await requeueBulkDLQJobs(['bulk-1', 'bulk-2']);

      expect(result).toMatchObject({ success: true, count: 2, missing: 0 });
      expect(mockAddWebhookJob).toHaveBeenCalledWith(payloadFor('del-1'), {
        jobId: webhookJobId('del-1'),
      });
      expect(job1.remove).toHaveBeenCalledOnce();
      expect(job2.remove).toHaveBeenCalledOnce();
    });

    it('counts ids that are no longer in the DLQ as missing rather than failing', async () => {
      mockGetJobDLQ.mockImplementation(async (id: string) =>
        id === 'bulk-1' ? dlqJob('bulk-1', payloadFor('del-1')) : null
      );

      const result = await requeueBulkDLQJobs(['bulk-1', 'gone']);

      expect(result).toMatchObject({ count: 1, missing: 1 });
      expect(result.summary).toContain('no longer in the queue');
    });

    it('returns an empty summary for an empty selection without touching Redis', async () => {
      const result = await requeueBulkDLQJobs([]);

      expect(result).toMatchObject({ success: true, count: 0 });
      expect(mockGetJobDLQ).not.toHaveBeenCalled();
    });

    it('throws Unauthorized for non-admin users', async () => {
      (auth as any).mockResolvedValue({ user: { id: 'user-1', roles: ['USER'] } });

      await expect(requeueBulkDLQJobs(['bulk-1'])).rejects.toThrow('Unauthorized');
    });
  });

  describe('deleteBulkDLQJobs', () => {
    it('deletes the selected jobs and reports the count', async () => {
      const job1 = dlqJob('bulk-1', payloadFor('del-1'));
      const job2 = dlqJob('bulk-2', payloadFor('del-2'));

      mockGetJobDLQ.mockImplementation(async (id: string) =>
        (({ 'bulk-1': job1, 'bulk-2': job2 }) as any)[id] ?? null
      );

      const result = await deleteBulkDLQJobs(['bulk-1', 'bulk-2']);

      expect(result).toMatchObject({ success: true, count: 2 });
      expect(job1.remove).toHaveBeenCalledOnce();
      expect(job2.remove).toHaveBeenCalledOnce();
      expect(auditCall()).toMatchObject({
        action: 'DLQ_DELETE_BULK',
        metadata: expect.objectContaining({ requested: 2 }),
      });
    });

    it('contains a per-job failure instead of aborting the rest', async () => {
      const good = dlqJob('bulk-2', payloadFor('del-2'));
      mockGetJobDLQ.mockImplementation(async (id: string) =>
        id === 'bulk-1'
          ? dlqJob('bulk-1', payloadFor('del-1'), vi.fn(async () => {
              throw new Error('nope');
            }))
          : good
      );

      const result = await deleteBulkDLQJobs(['bulk-1', 'bulk-2']);

      expect(result).toMatchObject({ count: 1, failed: 1 });
      expect(good.remove).toHaveBeenCalledOnce();
    });

    it('throws Unauthorized for non-admin users', async () => {
      (auth as any).mockResolvedValue({ user: { id: 'user-1', roles: ['USER'] } });

      await expect(deleteBulkDLQJobs(['bulk-1'])).rejects.toThrow('Unauthorized');
    });
  });
});
