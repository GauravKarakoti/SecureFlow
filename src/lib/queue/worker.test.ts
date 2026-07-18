import { describe, it, expect, vi, beforeEach } from 'vitest';

// Use vi.hoisted to declare mock callbacks
const mockWorkerOn = vi.hoisted(() => vi.fn());
const mockDLQAdd = vi.hoisted(() => vi.fn());

vi.mock('bullmq', () => {
  return {
    Worker: vi.fn().mockImplementation(function (this: any) {
      this.on = mockWorkerOn;
    }),
    Queue: vi.fn().mockImplementation(function (this: any) {
      this.add = mockDLQAdd;
    }),
  };
});

vi.mock('./redis', () => ({
  redis: {},
}));

vi.mock('@/lib/prisma', () => ({
  default: {},
}));

vi.mock('@/lib/armor/scanner', () => ({
  scanner: {},
}));

vi.mock('@/ai/flows/developer-receives-ai-security-explanations', () => ({
  developerReceivesAISecurityExplanations: vi.fn(),
}));

describe('Webhook Worker DLQ Routing', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.resetModules();
  });

  it('registers completed and failed listeners on the worker', async () => {
    // Importing worker executes the file and registers listeners
    await import('./worker');

    expect(mockWorkerOn).toHaveBeenCalledWith('completed', expect.any(Function));
    expect(mockWorkerOn).toHaveBeenCalledWith('failed', expect.any(Function));
  });

  it('routes to DLQ when job fails permanently (attempts exhausted)', async () => {
    await import('./worker');

    // Retrieve the registered failed handler
    const failedHandlerCall = mockWorkerOn.mock.calls.find(call => call[0] === 'failed');
    expect(failedHandlerCall).toBeDefined();

    const failedHandler = failedHandlerCall![1];

    const mockJob = {
      id: 'job-failed-123',
      name: 'process-webhook',
      data: { event: 'pull_request', payload: { action: 'opened' } },
      attemptsMade: 3,
      opts: { attempts: 3 },
    };
    const mockError = new Error('Rate limit exceeded');

    await failedHandler(mockJob, mockError);

    expect(mockDLQAdd).toHaveBeenCalledWith(
      'process-webhook-dlq',
      expect.objectContaining({
        originalJobId: 'job-failed-123',
        failedReason: 'Rate limit exceeded',
        attemptsMade: 3,
      }),
      { attempts: 1 }
    );
  });

  it('does NOT route to DLQ when job fails temporarily (attempts remaining)', async () => {
    await import('./worker');

    const failedHandlerCall = mockWorkerOn.mock.calls.find(call => call[0] === 'failed');
    const failedHandler = failedHandlerCall![1];

    const mockJob = {
      id: 'job-retry-123',
      name: 'process-webhook',
      data: { event: 'pull_request', payload: { action: 'opened' } },
      attemptsMade: 1,
      opts: { attempts: 3 },
    };
    const mockError = new Error('Temporary API error');

    await failedHandler(mockJob, mockError);

    expect(mockDLQAdd).not.toHaveBeenCalled();
  });
});
