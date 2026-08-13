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
import {
  MAX_VALIDATION_ERROR_LENGTH,
  WebhookConfigurationError,
  assertPullRequestContext,
  getCommentableLines,
  getGitHubAppCredentials,
  selectRepositoryList,
  truncateForError,
} from './worker';

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
describe('selectRepositoryList', () => {
  const repo = (id: number, fullName: string) => ({ id, full_name: fullName });

  it('reads `repositories` for an installation/created delivery', () => {
    const result = selectRepositoryList('installation', 'created', {
      repositories: [repo(1, 'acme/api')],
    });

    expect(result.intent).toBe('add');
    expect(result.repositories).toHaveLength(1);
  });

  it('returns an empty list when installation/created omits `repositories`', () => {
    // This is the regression: the old code called .map() straight onto
    // undefined, throwing a TypeError on a well-formed delivery.
    const result = selectRepositoryList('installation', 'created', {});

    expect(result.intent).toBe('add');
    expect(result.repositories).toEqual([]);
  });

  it('reads `repositories_added` for installation_repositories/added', () => {
    const result = selectRepositoryList('installation_repositories', 'added', {
      repositories_added: [repo(2, 'acme/web')],
    });

    expect(result.intent).toBe('add');
    expect(result.repositories[0].full_name).toBe('acme/web');
  });

  it('reads `repositories_removed` for installation_repositories/removed', () => {
    const result = selectRepositoryList('installation_repositories', 'removed', {
      repositories_removed: [repo(3, 'acme/old')],
    });

    expect(result.intent).toBe('remove');
    expect(result.repositories[0].full_name).toBe('acme/old');
  });

  it('does not fall back to `repositories_added` on a removed delivery', () => {
    const result = selectRepositoryList('installation_repositories', 'removed', {
      repositories_added: [repo(4, 'acme/wrong')],
    });

    expect(result.repositories).toEqual([]);
  });

  it('ignores unrelated events and actions', () => {
    expect(selectRepositoryList('pull_request', 'opened', {}).intent).toBe('ignore');
    expect(selectRepositoryList('installation', 'deleted', {}).intent).toBe('ignore');
    expect(selectRepositoryList('installation_repositories', 'weird', {}).intent).toBe('ignore');
  });

  it('drops malformed entries rather than passing them to BigInt()', () => {
    const result = selectRepositoryList('installation', 'created', {
      repositories: [repo(1, 'acme/api'), { nope: true }, null, 'string'],
    });

    expect(result.repositories).toHaveLength(1);
  });

  it('returns an empty list when the field is not an array', () => {
    expect(selectRepositoryList('installation', 'created', { repositories: 'oops' }).repositories).toEqual([]);
  });
});

describe('assertPullRequestContext', () => {
  const validPayload = () => ({
    pull_request: { number: 12, head: { sha: 'abc123' } },
    repository: { name: 'api', full_name: 'acme/api', owner: { login: 'acme' } },
  });

  it('returns the resolved context for a complete payload', () => {
    const ctx = assertPullRequestContext(validPayload());

    expect(ctx.ownerLogin).toBe('acme');
    expect(ctx.repoName).toBe('api');
    expect(ctx.headSha).toBe('abc123');
    expect(ctx.prNumber).toBe(12);
  });

  it('derives owner and name from full_name when they are absent', () => {
    const ctx = assertPullRequestContext({
      pull_request: { number: 1, head: { sha: 'deadbeef' } },
      repository: { full_name: 'acme/api' },
    });

    expect(ctx.ownerLogin).toBe('acme');
    expect(ctx.repoName).toBe('api');
  });

  it('throws when pull_request is missing', () => {
    expect(() => assertPullRequestContext({ repository: { full_name: 'a/b' } })).toThrow(/pull_request/);
  });

  it('throws when repository is missing', () => {
    expect(() =>
      assertPullRequestContext({ pull_request: { number: 1, head: { sha: 'x' } } })
    ).toThrow(/repository/);
  });

  it('throws when head.sha is missing', () => {
    const payload = validPayload();
    delete (payload.pull_request as any).head;

    expect(() => assertPullRequestContext(payload)).toThrow(/head\.sha/);
  });

  it('throws when the PR number is not a number', () => {
    const payload = validPayload();
    (payload.pull_request as any).number = '12';

    expect(() => assertPullRequestContext(payload)).toThrow(/pull_request\.number/);
  });

  it('names every missing field at once', () => {
    let message = '';
    try {
      assertPullRequestContext({});
    } catch (err) {
      message = (err as Error).message;
    }

    // One error listing everything, rather than fixing one field and
    // rediscovering the next on the following delivery.
    expect(message).toContain('pull_request');
    expect(message).toContain('repository');
    expect(message).toContain('pull_request.head.sha');
  });
});

describe('getGitHubAppCredentials', () => {
  it('returns both credentials when configured', () => {
    const creds = getGitHubAppCredentials({
      GITHUB_APP_ID: '12345',
      GITHUB_PRIVATE_KEY: 'line1\\nline2',
    });

    expect(creds.appId).toBe('12345');
    expect(creds.privateKey).toBe('line1\nline2');
  });

  it('leaves a key that already contains real newlines untouched', () => {
    const creds = getGitHubAppCredentials({
      GITHUB_APP_ID: '1',
      GITHUB_PRIVATE_KEY: 'line1\nline2',
    });

    expect(creds.privateKey).toBe('line1\nline2');
  });

  it('names GITHUB_APP_ID when it is missing', () => {
    expect(() => getGitHubAppCredentials({ GITHUB_PRIVATE_KEY: 'k' })).toThrow(/GITHUB_APP_ID/);
  });

  it('names GITHUB_PRIVATE_KEY when it is missing', () => {
    // Previously this surfaced as "Cannot read properties of undefined
    // (reading 'replace')" three retries later.
    expect(() => getGitHubAppCredentials({ GITHUB_APP_ID: '1' })).toThrow(/GITHUB_PRIVATE_KEY/);
  });

  it('treats a blank value as missing', () => {
    expect(() => getGitHubAppCredentials({ GITHUB_APP_ID: '  ', GITHUB_PRIVATE_KEY: 'k' })).toThrow(
      /GITHUB_APP_ID/
    );
    expect(() => getGitHubAppCredentials({ GITHUB_APP_ID: '1', GITHUB_PRIVATE_KEY: '   ' })).toThrow(
      /GITHUB_PRIVATE_KEY/
    );
  });

  it('throws WebhookConfigurationError, not a bare Error', () => {
    expect(() => getGitHubAppCredentials({})).toThrow(WebhookConfigurationError);
  });
});

describe('truncateForError', () => {
  it('leaves a short message alone', () => {
    expect(truncateForError('short')).toBe('short');
  });

  it('truncates and reports the original length', () => {
    const long = 'x'.repeat(MAX_VALIDATION_ERROR_LENGTH + 250);
    const result = truncateForError(long);

    expect(result.length).toBeLessThan(long.length);
    expect(result).toContain(`${long.length} chars total`);
  });

  it('honours an explicit maximum', () => {
    expect(truncateForError('abcdefghij', 4)).toMatch(/^abcd…/);
  });

  it('does not truncate at exactly the limit', () => {
    const exact = 'y'.repeat(MAX_VALIDATION_ERROR_LENGTH);
    expect(truncateForError(exact)).toBe(exact);
  });
});
