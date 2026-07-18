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

describe('getCommentableLines (diff-position guard)', () => {
  it('returns added and context lines from a single hunk, excluding removed lines', async () => {
    const { getCommentableLines } = await import('./worker');
    // New side starts at line 10: context(10), removed(-), added(11), context(12)
    const patch = ['@@ -10,3 +10,3 @@', ' const a = 1;', '-const b = 2;', '+const b = 3;', ' const c = 4;'].join('\n');

    const lines = getCommentableLines(patch);

    expect([...lines].sort((x, y) => x - y)).toEqual([10, 11, 12]);
  });

  it('handles multiple hunks and only-added lines', async () => {
    const { getCommentableLines } = await import('./worker');
    const patch = [
      '@@ -1,2 +1,3 @@',
      ' line one',
      '+new line two',
      ' line three',
      '@@ -20,0 +21,2 @@',
      '+added twentyone',
      '+added twentytwo',
    ].join('\n');

    const lines = getCommentableLines(patch);

    expect(lines.has(2)).toBe(true);   // added line in first hunk
    expect(lines.has(21)).toBe(true);  // added line in second hunk
    expect(lines.has(22)).toBe(true);
    expect(lines.has(20)).toBe(false); // never present on the new side
  });

  it('returns an empty set for a patch with only removed lines', async () => {
    const { getCommentableLines } = await import('./worker');
    const patch = ['@@ -5,2 +5,0 @@', '-gone one', '-gone two'].join('\n');

    expect(getCommentableLines(patch).size).toBe(0);
  });
});
