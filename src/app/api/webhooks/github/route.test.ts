import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { POST } from './route';
import prisma from '@/lib/prisma';

const { mockChecksCreate, mockChecksUpdate, mockPaginate } = vi.hoisted(() => {
  return {
    mockChecksCreate: vi.fn().mockResolvedValue({ data: { id: 789 } }),
    mockChecksUpdate: vi.fn().mockResolvedValue({}),
    mockPaginate: vi.fn(),
  };
});

vi.mock('octokit', () => {
  return {
    Octokit: {
      plugin: vi.fn().mockReturnValue({
        defaults: vi.fn().mockReturnValue(vi.fn()),
      }),
    },
    App: class {
      getInstallationOctokit = vi.fn().mockResolvedValue({
        rest: {
          checks: {
            create: mockChecksCreate,
            update: mockChecksUpdate,
          },
          pulls: {
            listFiles: {},
          },
        },
        paginate: mockPaginate,
      });
    },
  };
});

vi.mock('crypto', () => {
  return {
    createHmac: () => ({
      update: () => ({
        digest: () => 'mock-digest',
      }),
    }),
    timingSafeEqual: () => true,
  };
});

vi.mock('next/server', () => {
  class MockNextRequest {
    headers = new Map();
    bodyText = '';
    url = '';
    method = '';

    constructor(url: string, init?: any) {
      this.url = url;
      this.method = init?.method || 'GET';
      this.bodyText = init?.body || '';
      if (init?.headers) {
        Object.entries(init.headers).forEach(([k, v]) => {
          this.headers.set(k.toLowerCase(), v);
        });
      }
    }

    async text() {
      return this.bodyText;
    }
  }

  return {
    NextRequest: MockNextRequest,
    NextResponse: {
      json: vi.fn((body, init) => {
        return {
          body,
          status: init?.status || 200,
        };
      }),
    },
  };
});

vi.mock('@/lib/middleware/rateLimit', () => {
  return {
    withRateLimit: (handler: any) => handler,
  };
});

vi.mock('@/lib/prisma', () => {
  return {
    default: {
      account: {
        findFirst: vi.fn(),
      },
      webhookEvent: {
        findUnique: vi.fn(),
        create: vi.fn(),
        update: vi.fn(),
      },
      repository: {
        upsert: vi.fn(),
        findUnique: vi.fn(),
      },
      pullRequest: {
        findUnique: vi.fn(),
        upsert: vi.fn(),
      },
      policyTemplate: {
        findMany: vi.fn(),
      },
      userPolicyToggle: {
        findMany: vi.fn(),
      },
      auditLog: {
        create: vi.fn(),
      },
      $transaction: vi.fn(),
    },
  };
});

// Import NextRequest from next/server which will now use the mocked version
import { NextRequest } from 'next/server';

describe('GitHub Webhooks - App Installation Chunking', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    vi.clearAllMocks();
    process.env = {
      ...originalEnv,
      GITHUB_WEBHOOK_SECRET: 'test-secret',
      GITHUB_APP_ID: '123456',
      GITHUB_PRIVATE_KEY: 'test-private-key',
    };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it('chunks installation repositories transaction into batches of 50', async () => {
    // 120 repositories
    const mockRepos = Array.from({ length: 120 }, (_, i) => ({
      id: 1000 + i,
      full_name: `org/repo-${i}`,
    }));

    const mockAccount = { userId: 'user-123' };
    vi.mocked(prisma.account.findFirst).mockResolvedValue(mockAccount as any);
    vi.mocked(prisma.webhookEvent.findUnique).mockResolvedValue(null);

    const req = new NextRequest('http://localhost/api/webhooks/github', {
      method: 'POST',
      headers: {
        'x-github-event': 'installation',
        'x-github-delivery': 'delivery-123',
        'x-hub-signature-256': 'sha256=mock-signature',
      },
      body: JSON.stringify({
        action: 'created',
        installation: { id: 12345 },
        repositories: mockRepos,
        sender: { id: 999 },
      }),
    });

    const response = await POST(req as any);

    // Verify response
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ success: true, message: 'Repositories populated' });

    // Verify transaction chunking
    // We expect 3 calls to prisma.$transaction
    expect(prisma.$transaction).toHaveBeenCalledTimes(3);

    // Call 1: 50 upserts
    const call1Args = vi.mocked(prisma.$transaction).mock.calls[0][0];
    expect(call1Args).toHaveLength(50);

    // Call 2: 50 upserts
    const call2Args = vi.mocked(prisma.$transaction).mock.calls[1][0];
    expect(call2Args).toHaveLength(50);

    // Call 3: 20 upserts
    const call3Args = vi.mocked(prisma.$transaction).mock.calls[2][0];
    expect(call3Args).toHaveLength(20);

    // Audit log should be created separately after the transactions
    expect(prisma.auditLog.create).toHaveBeenCalledTimes(1);
    expect(prisma.auditLog.create).toHaveBeenCalledWith({
      data: {
        userId: 'user-123',
        action: 'Repository Added',
        resource: mockRepos.map(r => r.full_name).join(', '),
        metadata: { count: 120, event: 'installation' },
      },
    });
  });

  it('chunks installation_repositories added transaction into batches of 50', async () => {
    // 65 repositories added
    const mockReposAdded = Array.from({ length: 65 }, (_, i) => ({
      id: 2000 + i,
      full_name: `org/new-repo-${i}`,
    }));

    const mockAccount = { userId: 'user-123' };
    vi.mocked(prisma.account.findFirst).mockResolvedValue(mockAccount as any);
    vi.mocked(prisma.webhookEvent.findUnique).mockResolvedValue(null);

    const req = new NextRequest('http://localhost/api/webhooks/github', {
      method: 'POST',
      headers: {
        'x-github-event': 'installation_repositories',
        'x-github-delivery': 'delivery-456',
        'x-hub-signature-256': 'sha256=mock-signature',
      },
      body: JSON.stringify({
        action: 'added',
        installation: { id: 12345 },
        repositories_added: mockReposAdded,
        sender: { id: 999 },
      }),
    });

    const response = await POST(req as any);

    // Verify response
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ success: true, message: 'New repositories added' });

    // Verify transaction chunking
    // We expect 2 calls to prisma.$transaction
    expect(prisma.$transaction).toHaveBeenCalledTimes(2);

    // Call 1: 50 upserts
    const call1Args = vi.mocked(prisma.$transaction).mock.calls[0][0];
    expect(call1Args).toHaveLength(50);

    // Call 2: 15 upserts
    const call2Args = vi.mocked(prisma.$transaction).mock.calls[1][0];
    expect(call2Args).toHaveLength(15);

    // Audit log should be created separately after the transactions
    expect(prisma.auditLog.create).toHaveBeenCalledTimes(1);
    expect(prisma.auditLog.create).toHaveBeenCalledWith({
      data: {
        userId: 'user-123',
        action: 'Repository Added',
        resource: mockReposAdded.map(r => r.full_name).join(', '),
        metadata: { count: 65, event: 'installation_repositories' },
      },
    });
  });

  it('handles GitHub API rate limiting gracefully and returns 202', async () => {
    const mockRepo = {
      id: 999,
      full_name: 'org/repo',
      name: 'repo',
      owner: { login: 'org' },
    };

    const mockPR = {
      id: 888,
      number: 42,
      head: { sha: 'abcdef' },
      user: { login: 'user-dev' },
    };

    // Mock prisma responses
    vi.mocked(prisma.webhookEvent.findUnique).mockResolvedValue(null);
    vi.mocked(prisma.repository.findUnique).mockResolvedValue({
      id: 'repo-db-id',
      userId: 'user-123',
    } as any);
    vi.mocked(prisma.pullRequest.findUnique).mockResolvedValue(null);
    vi.mocked(prisma.policyTemplate.findMany).mockResolvedValue([]);
    vi.mocked(prisma.userPolicyToggle.findMany).mockResolvedValue([]);

    // Mock paginate to throw rate limit error
    const rateLimitError = new Error('Rate limit exceeded');
    (rateLimitError as any).status = 429;
    mockPaginate.mockRejectedValueOnce(rateLimitError);

    const req = new NextRequest('http://localhost/api/webhooks/github', {
      method: 'POST',
      headers: {
        'x-github-event': 'pull_request',
        'x-github-delivery': 'delivery-789',
        'x-hub-signature-256': 'sha256=mock-signature',
      },
      body: JSON.stringify({
        action: 'opened',
        installation: { id: 12345 },
        repository: mockRepo,
        pull_request: mockPR,
      }),
    });

    const response = await POST(req as any);

    // Check response status and body
    expect(response.status).toBe(202);
    expect(response.body).toEqual({
      success: false,
      message: 'Rate limit exceeded, check run updated to failure',
    });

    // Check checks.create and checks.update were called
    expect(mockChecksCreate).toHaveBeenCalledWith(expect.objectContaining({
      owner: 'org',
      repo: 'repo',
      name: 'SecureFlow Scan',
      status: 'in_progress',
    }));

    expect(mockChecksUpdate).toHaveBeenCalledWith(expect.objectContaining({
      owner: 'org',
      repo: 'repo',
      check_run_id: 789,
      status: 'completed',
      conclusion: 'failure',
      output: expect.objectContaining({
        title: 'Scan Failed: API Rate Limit',
      }),
    }));
  });
});
