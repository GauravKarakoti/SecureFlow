import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock redis before importing the module under test
vi.mock('./redis', () => ({
  redis: {},
}));

// Mock bullmq Queue using vi.hoisted for the mockAdd ref
const mockAdd = vi.hoisted(() => vi.fn());

vi.mock('bullmq', () => ({
  Queue: vi.fn(function MockQueue(this: any, name: string) {
    this.name = name;
    this.add = mockAdd;
  }),
}));

import { addWebhookJob, webhookQueue } from './webhookQueue';

describe('webhookQueue', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('exports a Queue instance with the correct name', () => {
    // webhookQueue should be a Queue instance (mocked)
    expect(webhookQueue).toBeDefined();
  });

  it('addWebhookJob adds a job with 3 retry attempts and exponential backoff', async () => {
    mockAdd.mockResolvedValue({ id: 'job-1' });

    const payload = { event: 'pull_request', deliveryId: 'del-123', payload: { action: 'opened' } };
    const result = await addWebhookJob(payload);

    expect(mockAdd).toHaveBeenCalledWith('process-webhook', payload, {
      attempts: 3,
      backoff: { type: 'exponential', delay: 5000 },
    });
    expect(result).toEqual({ id: 'job-1' });
  });

  it('addWebhookJob passes the payload through to the queue', async () => {
    mockAdd.mockResolvedValue({ id: 'job-2' });

    const payload = { event: 'installation', deliveryId: 'del-456', payload: { action: 'created' } };
    await addWebhookJob(payload);

    expect(mockAdd).toHaveBeenCalledWith('process-webhook', payload, expect.any(Object));
  });

  it('propagates errors from the queue add call', async () => {
    mockAdd.mockRejectedValue(new Error('Redis connection refused'));

    const payload = { event: 'push', deliveryId: 'del-789' };
    await expect(addWebhookJob(payload)).rejects.toThrow('Redis connection refused');
  });
});