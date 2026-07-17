import { describe, it, expect, vi, beforeEach } from 'vitest';
import { getQueueMetrics } from '@/lib/actions/queue';
import { auth } from '@/auth';

// Mock the dependencies
vi.mock('@/auth', () => ({
  auth: vi.fn(),
}));

// Use vi.hoisted to create the mock before vi.mock is hoisted
const mockGetJobCounts = vi.hoisted(() => vi.fn());

vi.mock('@/lib/queue/webhookQueue', () => ({
  webhookQueue: {
    getJobCounts: mockGetJobCounts,
  },
}));

describe('getQueueMetrics', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns job counts for an ADMIN user', async () => {
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

    const result = await getQueueMetrics();
    expect(result).toEqual({
      waiting: 5,
      active: 2,
      completed: 150,
      failed: 3,
      delayed: 0,
    });
    expect(mockGetJobCounts).toHaveBeenCalledWith('waiting', 'active', 'completed', 'failed', 'delayed');
  });

  it('throws Unauthorized for non-admin users', async () => {
    (auth as any).mockResolvedValue({
      user: { id: 'user-1', roles: ['USER'] },
    });

    await expect(getQueueMetrics()).rejects.toThrow('Unauthorized');
    expect(mockGetJobCounts).not.toHaveBeenCalled();
  });

  it('throws Unauthorized when session is null', async () => {
    (auth as any).mockResolvedValue(null);

    await expect(getQueueMetrics()).rejects.toThrow('Unauthorized');
    expect(mockGetJobCounts).not.toHaveBeenCalled();
  });

  it('throws Unauthorized when roles array is empty', async () => {
    (auth as any).mockResolvedValue({
      user: { id: 'user-1', roles: [] },
    });

    await expect(getQueueMetrics()).rejects.toThrow('Unauthorized');
    expect(mockGetJobCounts).not.toHaveBeenCalled();
  });
});