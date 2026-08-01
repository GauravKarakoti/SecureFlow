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
import { auth } from '@/auth';
import { revalidatePath } from 'next/cache';

// Mock the dependencies
vi.mock('@/auth', () => ({
  auth: vi.fn(),
}));

vi.mock('next/cache', () => ({
  revalidatePath: vi.fn(),
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

describe('Queue Actions & DLQ', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('getQueueMetrics', () => {
    it('returns combined job counts (failed count overridden by DLQ waiting) for an ADMIN user', async () => {
      (auth as any).mockResolvedValue({
        user: { id: 'admin-1', roles: ['ADMIN'] },
      });

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
        failed: 12, // overridden
        delayed: 0,
      });
      expect(mockGetJobCounts).toHaveBeenCalledWith('waiting', 'active', 'completed', 'failed', 'delayed');
      expect(mockGetJobCountsDLQ).toHaveBeenCalledWith('waiting');
    });

    it('throws Unauthorized for non-admin users', async () => {
      (auth as any).mockResolvedValue({
        user: { id: 'user-1', roles: ['USER'] },
      });

      await expect(getQueueMetrics()).rejects.toThrow('Unauthorized');
    });
  });

  describe('getDLQJobs', () => {
    it('returns DLQ jobs for an ADMIN user', async () => {
      (auth as any).mockResolvedValue({
        user: { id: 'admin-1', roles: ['ADMIN'] },
      });

      const mockJob = {
        id: 'dlq-job-123',
        name: 'process-webhook-dlq',
        data: { failedReason: 'Timeout error', failedAt: '2026-07-17T22:00:00Z' },
        timestamp: 123456789,
      };
      mockGetJobsDLQ.mockResolvedValue([mockJob]);

      const result = await getDLQJobs();
      expect(result).toEqual([
        {
          id: 'dlq-job-123',
          name: 'process-webhook-dlq',
          data: { failedReason: 'Timeout error', failedAt: '2026-07-17T22:00:00Z' },
          timestamp: 123456789,
        },
      ]);
      expect(mockGetJobsDLQ).toHaveBeenCalledWith(['waiting']);
    });
  });

  describe('requeueDLQJob', () => {
    it('requeues a DLQ job and removes it from the DLQ for an ADMIN user', async () => {
      (auth as any).mockResolvedValue({
        user: { id: 'admin-1', roles: ['ADMIN'] },
      });

      const mockJobRemove = vi.fn();
      const mockJob = {
        id: 'dlq-job-1',
        data: {
          data: { payload: { action: 'opened' }, event: 'pull_request' },
        },
        remove: mockJobRemove,
      };

      mockGetJobDLQ.mockResolvedValue(mockJob);

      const result = await requeueDLQJob('dlq-job-1');
      expect(result).toEqual({ success: true });
      expect(mockAddWebhookJob).toHaveBeenCalledWith(mockJob.data.data);
      expect(mockJobRemove).toHaveBeenCalledOnce();
      expect(revalidatePath).toHaveBeenCalledWith('/admin/queue');
    });
  });

  describe('deleteDLQJob', () => {
    it('deletes a DLQ job from DLQ for an ADMIN user', async () => {
      (auth as any).mockResolvedValue({
        user: { id: 'admin-1', roles: ['ADMIN'] },
      });

      const mockJobRemove = vi.fn();
      const mockJob = {
        id: 'dlq-job-2',
        remove: mockJobRemove,
      };

      mockGetJobDLQ.mockResolvedValue(mockJob);

      const result = await deleteDLQJob('dlq-job-2');
      expect(result).toEqual({ success: true });
      expect(mockJobRemove).toHaveBeenCalledOnce();
      expect(revalidatePath).toHaveBeenCalledWith('/admin/queue');
    });
  });

  describe('clearAllDLQ', () => {
    it('removes all jobs from the DLQ for an ADMIN user', async () => {
      (auth as any).mockResolvedValue({
        user: { id: 'admin-1', roles: ['ADMIN'] },
      });

      const mockJobRemove1 = vi.fn();
      const mockJobRemove2 = vi.fn();
      mockGetJobsDLQ.mockResolvedValue([
        { id: '1', remove: mockJobRemove1 },
        { id: '2', remove: mockJobRemove2 },
      ]);

      const result = await clearAllDLQ();
      expect(result).toEqual({ success: true });
      expect(mockJobRemove1).toHaveBeenCalledOnce();
      expect(mockJobRemove2).toHaveBeenCalledOnce();
      expect(revalidatePath).toHaveBeenCalledWith('/admin/queue');
    });
  });

  describe('requeueAllDLQ', () => {
    it('requeues and removes all jobs from the DLQ for an ADMIN user', async () => {
      (auth as any).mockResolvedValue({
        user: { id: 'admin-1', roles: ['ADMIN'] },
      });

      const mockJobRemove1 = vi.fn();
      const mockJobRemove2 = vi.fn();
      mockGetJobsDLQ.mockResolvedValue([
        { id: '1', data: { data: 'payload1' }, remove: mockJobRemove1 },
        { id: '2', data: { data: 'payload2' }, remove: mockJobRemove2 },
      ]);

      const result = await requeueAllDLQ();
      expect(result).toEqual({ success: true });
      expect(mockAddWebhookJob).toHaveBeenNthCalledWith(1, 'payload1');
      expect(mockAddWebhookJob).toHaveBeenNthCalledWith(2, 'payload2');
      expect(mockJobRemove1).toHaveBeenCalledOnce();
      expect(mockJobRemove2).toHaveBeenCalledOnce();
      expect(revalidatePath).toHaveBeenCalledWith('/admin/queue');
    });
  });

  describe('requeueBulkDLQJobs', () => {
    it('requeues specified DLQ jobs and removes them from the DLQ for an ADMIN user', async () => {
      (auth as any).mockResolvedValue({
        user: { id: 'admin-1', roles: ['ADMIN'] },
      });

      const mockRemove1 = vi.fn();
      const mockRemove2 = vi.fn();
      const mockJob1 = { id: 'bulk-1', data: { data: { event: 'push', payload: { action: 'created' } } }, remove: mockRemove1 };
      const mockJob2 = { id: 'bulk-2', data: { data: { event: 'issues', payload: { action: 'opened' } } }, remove: mockRemove2 };

      mockGetJobDLQ.mockImplementation((id: string) => {
        if (id === 'bulk-1') return Promise.resolve(mockJob1);
        if (id === 'bulk-2') return Promise.resolve(mockJob2);
        return Promise.resolve(null);
      });

      const result = await requeueBulkDLQJobs(['bulk-1', 'bulk-2']);
      expect(result).toEqual({ success: true, count: 2 });
      expect(mockAddWebhookJob).toHaveBeenCalledWith(mockJob1.data.data);
      expect(mockAddWebhookJob).toHaveBeenCalledWith(mockJob2.data.data);
      expect(mockRemove1).toHaveBeenCalledOnce();
      expect(mockRemove2).toHaveBeenCalledOnce();
      expect(revalidatePath).toHaveBeenCalledWith('/admin/queue');
    });

    it('throws Unauthorized for non-admin users', async () => {
      (auth as any).mockResolvedValue({
        user: { id: 'user-1', roles: ['USER'] },
      });

      await expect(requeueBulkDLQJobs(['bulk-1'])).rejects.toThrow('Unauthorized');
    });
  });

  describe('deleteBulkDLQJobs', () => {
    it('deletes specified DLQ jobs from the DLQ for an ADMIN user', async () => {
      (auth as any).mockResolvedValue({
        user: { id: 'admin-1', roles: ['ADMIN'] },
      });

      const mockRemove1 = vi.fn();
      const mockRemove2 = vi.fn();
      const mockJob1 = { id: 'bulk-1', remove: mockRemove1 };
      const mockJob2 = { id: 'bulk-2', remove: mockRemove2 };

      mockGetJobDLQ.mockImplementation((id: string) => {
        if (id === 'bulk-1') return Promise.resolve(mockJob1);
        if (id === 'bulk-2') return Promise.resolve(mockJob2);
        return Promise.resolve(null);
      });

      const result = await deleteBulkDLQJobs(['bulk-1', 'bulk-2']);
      expect(result).toEqual({ success: true, count: 2 });
      expect(mockRemove1).toHaveBeenCalledOnce();
      expect(mockRemove2).toHaveBeenCalledOnce();
      expect(revalidatePath).toHaveBeenCalledWith('/admin/queue');
    });

    it('throws Unauthorized for non-admin users', async () => {
      (auth as any).mockResolvedValue({
        user: { id: 'user-1', roles: ['USER'] },
      });

      await expect(deleteBulkDLQJobs(['bulk-1'])).rejects.toThrow('Unauthorized');
    });
  });
});