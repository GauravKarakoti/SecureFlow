import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---- Mocks ----
//
// The routes are exercised through their exported handlers rather than through
// the pure helpers alone, because the whole defect was an absent call: a test of
// `loadOwnedRepository` would have passed on the vulnerable route too.

const { authMock, enqueueScanMock, repositoryFindFirst, scanJobFindUnique, scanJobStatusMock } =
  vi.hoisted(() => ({
    authMock: vi.fn(),
    enqueueScanMock: vi.fn(),
    repositoryFindFirst: vi.fn(),
    scanJobFindUnique: vi.fn(),
    scanJobStatusMock: vi.fn(),
  }));

vi.mock('@/auth', () => ({ auth: authMock }));

vi.mock('@/lib/prisma', () => ({
  default: {
    repository: { findFirst: repositoryFindFirst },
    scanJob: { findUnique: scanJobFindUnique },
  },
}));

vi.mock('@/lib/queue/scanQueue', () => ({
  enqueueScan: enqueueScanMock,
  getScanJobStatus: scanJobStatusMock,
}));

vi.mock('@/lib/middleware/error-handler', () => {
  class AppError extends Error {
    statusCode: number;
    constructor(msg: string, code = 400) {
      super(msg);
      this.statusCode = code;
    }
  }

  return {
    AppError,
    withErrorHandler:
      (fn: (...args: unknown[]) => unknown) =>
      async (...args: unknown[]) => {
        try {
          return await fn(...args);
        } catch (err: unknown) {
          const e = err as { statusCode?: number; message?: string };
          return new Response(JSON.stringify({ error: e.message }), {
            status: e.statusCode ?? 500,
            headers: { 'content-type': 'application/json' },
          });
        }
      },
  };
});

/** Captures what each route asks `withRateLimit` for. */
const { rateLimitConfigs } = vi.hoisted(() => ({
  rateLimitConfigs: [] as Array<{ keyPrefix: string }>,
}));

vi.mock('@/lib/middleware/rate-limit', () => ({
  TIERS: { STANDARD: { limit: 120, windowSeconds: 60, fallbackStrategy: 'fail-open' } },
  withRateLimit: <T>(handler: T, config: { keyPrefix: string }): T => {
    rateLimitConfigs.push(config);
    return handler;
  },
}));

// ---- Imports (after mocks) ----

import { POST } from '@/app/api/findings/route';
import { GET } from '@/app/api/findings/status/[jobId]/route';

const OWNED_REPO = { id: 'repo-1', fullName: 'me/mine' };

const VALID_BODY = {
  repositoryId: 'repo-1',
  installationId: 12345678,
  prNumber: 7,
  headSha: 'a'.repeat(40),
};

function postRequest(body: unknown) {
  return new Request('http://localhost:9002/api/findings', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  }) as never;
}

function statusRequest() {
  return new Request('http://localhost:9002/api/findings/status/job-1') as never;
}

beforeEach(() => {
  vi.clearAllMocks();
  authMock.mockResolvedValue({ user: { id: 'user-1' } });
  repositoryFindFirst.mockResolvedValue(OWNED_REPO);
  enqueueScanMock.mockResolvedValue({ jobId: 'scan-1', scanJobId: 'sj-1' });
  scanJobFindUnique.mockResolvedValue({
    repositoryId: 'repo-1',
    repository: { userId: 'user-1' },
  });
  scanJobStatusMock.mockResolvedValue({
    scanJobId: 'sj-1',
    status: 'COMPLETED',
    riskScore: 40,
    progress: 100,
  });
});

describe('POST /api/findings', () => {
  it('refuses an anonymous request', async () => {
    authMock.mockResolvedValue(null);

    const res = await POST(postRequest(VALID_BODY));

    expect(res.status).toBe(401);
    expect(enqueueScanMock).not.toHaveBeenCalled();
  });

  it('refuses a session with no user id', async () => {
    authMock.mockResolvedValue({ user: {} });

    const res = await POST(postRequest(VALID_BODY));

    expect(res.status).toBe(401);
    expect(enqueueScanMock).not.toHaveBeenCalled();
  });

  it('does not reach the database before checking the session', async () => {
    authMock.mockResolvedValue(null);

    await POST(postRequest(VALID_BODY));

    expect(repositoryFindFirst).not.toHaveBeenCalled();
  });

  it('enqueues for a repository the caller owns', async () => {
    const res = await POST(postRequest(VALID_BODY));

    expect(res.status).toBe(202);
    expect(await res.json()).toMatchObject({
      status: 'queued',
      jobId: 'scan-1',
      scanJobId: 'sj-1',
      pollingUrl: '/api/findings/status/sj-1',
    });
  });

  it('scopes the repository lookup to the session user', async () => {
    await POST(postRequest(VALID_BODY));

    expect(repositoryFindFirst).toHaveBeenCalledWith({
      where: { id: 'repo-1', userId: 'user-1' },
      select: { id: true, fullName: true },
    });
  });

  it('answers 404 for a repository the caller does not own', async () => {
    repositoryFindFirst.mockResolvedValue(null);

    const res = await POST(postRequest(VALID_BODY));

    expect(res.status).toBe(404);
    expect(enqueueScanMock).not.toHaveBeenCalled();
  });

  it('ignores a repositoryFullName in the body', async () => {
    // This is the field that let an anonymous caller make the GitHub App post a
    // check run and a comment on somebody else's pull request.
    await POST(postRequest({ ...VALID_BODY, repositoryFullName: 'attacker/target' }));

    expect(enqueueScanMock).toHaveBeenCalledTimes(1);
    expect(enqueueScanMock.mock.calls[0][0].repositoryFullName).toBe('me/mine');
  });

  it('ignores a userId in the body', async () => {
    await POST(postRequest({ ...VALID_BODY, userId: 'victim-user' }));

    expect(enqueueScanMock.mock.calls[0][0].userId).toBe('user-1');
  });

  it('rejects a malformed body with 400', async () => {
    const res = await POST(postRequest({ repositoryId: 'repo-1' }));

    expect(res.status).toBe(400);
    expect(enqueueScanMock).not.toHaveBeenCalled();
  });

  it('rejects a body that is not JSON', async () => {
    const req = new Request('http://localhost:9002/api/findings', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: 'not json',
    }) as never;

    const res = await POST(req);

    expect(res.status).toBe(400);
  });

  it('is not cached', async () => {
    const res = await POST(postRequest(VALID_BODY));

    expect(res.headers.get('cache-control')).toBe('no-store');
  });

  it('keeps its own rate-limit bucket', () => {
    expect(rateLimitConfigs.map((c) => c.keyPrefix)).toContain('findings:scan');
  });
});

describe('GET /api/findings/status/[jobId]', () => {
  const params = Promise.resolve({ jobId: 'job-1' });

  it('refuses an anonymous request', async () => {
    authMock.mockResolvedValue(null);

    const res = await GET(statusRequest(), { params });

    expect(res.status).toBe(401);
    expect(scanJobStatusMock).not.toHaveBeenCalled();
  });

  it('returns the status for a job the caller owns', async () => {
    const res = await GET(statusRequest(), { params });

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ scanJobId: 'sj-1', status: 'COMPLETED' });
  });

  it('answers 404 for a job belonging to another account', async () => {
    scanJobFindUnique.mockResolvedValue({
      repositoryId: 'repo-9',
      repository: { userId: 'someone-else' },
    });

    const res = await GET(statusRequest(), { params });

    expect(res.status).toBe(404);
  });

  it('does not read the job payload for a job it will not show', async () => {
    scanJobFindUnique.mockResolvedValue({
      repositoryId: 'repo-9',
      repository: { userId: 'someone-else' },
    });

    await GET(statusRequest(), { params });

    expect(scanJobStatusMock).not.toHaveBeenCalled();
  });

  it('gives the same answer for a job that does not exist', async () => {
    scanJobFindUnique.mockResolvedValue(null);

    const res = await GET(statusRequest(), { params });
    const body = await res.json();

    expect(res.status).toBe(404);
    expect(body.error).toBe('Scan job not found');
  });

  it('answers 404 for a job with no repository', async () => {
    scanJobFindUnique.mockResolvedValue({ repositoryId: null, repository: null });

    const res = await GET(statusRequest(), { params });

    expect(res.status).toBe(404);
  });

  it('rejects an empty job id', async () => {
    const res = await GET(statusRequest(), { params: Promise.resolve({ jobId: '' }) });

    expect(res.status).toBe(400);
  });

  it('is rate limited under its own bucket', () => {
    expect(rateLimitConfigs.map((c) => c.keyPrefix)).toContain('findings:status');
  });

  it('is not cached', async () => {
    const res = await GET(statusRequest(), { params });

    expect(res.headers.get('cache-control')).toContain('no-store');
  });
});
