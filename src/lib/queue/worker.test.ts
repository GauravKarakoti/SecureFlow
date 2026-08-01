import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---- Mocks (must be hoisted before imports) ----
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

vi.mock('./redis', () => ({ redis: {} }));
vi.mock('@/lib/prisma', () => ({ default: {} }));
vi.mock('@/lib/armor/scanner', () => ({ scanner: {}, parseSecureFlowIgnore: vi.fn() }));
vi.mock('@/ai/flows/developer-receives-ai-security-explanations', () => ({
  developerReceivesAISecurityExplanations: vi.fn(),
}));

// ---- Imports (after mocks) ----
// This executes the file once and instantly triggers the worker.on() calls
import { getCommentableLines } from './worker';

describe('Webhook Worker DLQ Routing', () => {
  beforeEach(() => {
    // Only clear the DLQ tracker. 
    // Do NOT clear mockWorkerOn, because the worker was only instantiated once upon import!
    mockDLQAdd.mockClear();
  });

  it('registers completed and failed listeners on the worker', () => {
    expect(mockWorkerOn).toHaveBeenCalledWith('completed', expect.any(Function));
    expect(mockWorkerOn).toHaveBeenCalledWith('failed', expect.any(Function));
  });

  it('routes to DLQ when job fails permanently (attempts exhausted)', async () => {
    const failedHandlerCall = mockWorkerOn.mock.calls.find(call => call[0] === 'failed');
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

  it('uses default maxAttempts of 3 when job.opts.attempts is missing (retry on attempt 2)', async () => {
    const failedHandlerCall = mockWorkerOn.mock.calls.find(call => call[0] === 'failed');
    const failedHandler = failedHandlerCall![1];

    const mockJob = {
      id: 'job-no-opts-retry',
      name: 'process-webhook',
      data: { event: 'pull_request', payload: { action: 'opened' } },
      attemptsMade: 2,
      opts: {},
    };
    const mockError = new Error('Database connection timeout');

    await failedHandler(mockJob, mockError);

    expect(mockDLQAdd).not.toHaveBeenCalled();
  });

  it('uses default maxAttempts of 3 when job.opts.attempts is missing (DLQ on attempt 3)', async () => {
    const failedHandlerCall = mockWorkerOn.mock.calls.find(call => call[0] === 'failed');
    const failedHandler = failedHandlerCall![1];

    const mockJob = {
      id: 'job-no-opts-dlq',
      name: 'process-webhook',
      data: { event: 'pull_request', payload: { action: 'opened' } },
      attemptsMade: 3,
      opts: {},
    };
    const mockError = new Error('Database connection timeout');

    await failedHandler(mockJob, mockError);

    expect(mockDLQAdd).toHaveBeenCalledWith(
      'process-webhook-dlq',
      expect.objectContaining({
        originalJobId: 'job-no-opts-dlq',
        failedReason: 'Database connection timeout',
        attemptsMade: 3,
      }),
      { attempts: 1 }
    );
  });
});

describe('getCommentableLines (diff-position guard)', () => {
  it('returns added and context lines from a single hunk, excluding removed lines', () => {
    const patch = ['@@ -10,3 +10,3 @@', ' const a = 1;', '-const b = 2;', '+const b = 3;', ' const c = 4;'].join('\n');
    const lines = getCommentableLines(patch);
    expect([...lines].sort((x, y) => x - y)).toEqual([10, 11, 12]);
  });

  it('handles multiple hunks and only-added lines', () => {
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

  it('returns an empty set for a patch with only removed lines', () => {
    const patch = ['@@ -5,2 +5,0 @@', '-gone one', '-gone two'].join('\n');
    expect(getCommentableLines(patch).size).toBe(0);
  });
});