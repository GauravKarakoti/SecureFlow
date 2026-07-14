import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { POST } from './route';
import prisma from '@/lib/prisma';
import { addWebhookJob } from '@/lib/queue/webhookQueue';

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

vi.mock('@/lib/queue/webhookQueue', () => {
  return {
    addWebhookJob: vi.fn().mockResolvedValue({ id: 'mock-job-id' }),
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

  it('enqueues installation repositories event successfully', async () => {
    // 120 repositories
    const mockRepos = Array.from({ length: 120 }, (_, i) => ({
      id: 1000 + i,
      full_name: `org/repo-${i}`,
    }));

    vi.mocked(prisma.webhookEvent.findUnique).mockResolvedValue(null);

    const payload = {
      action: 'created',
      installation: { id: 12345 },
      repositories: mockRepos,
      sender: { id: 999 },
    };

    const req = new NextRequest('http://localhost/api/webhooks/github', {
      method: 'POST',
      headers: {
        'x-github-event': 'installation',
        'x-github-delivery': 'delivery-123',
        'x-hub-signature-256': 'sha256=mock-signature',
      },
      body: JSON.stringify(payload),
    });

    const response = await POST(req as any);

    // Verify response
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ status: 'queued' });

    // Verify event is saved in database
    expect(prisma.webhookEvent.create).toHaveBeenCalledWith({
      data: {
        deliveryId: 'delivery-123',
        repositoryId: undefined,
        pullRequestId: undefined,
      },
    });

    // Verify background job was enqueued
    expect(addWebhookJob).toHaveBeenCalledWith({
      payload,
      deliveryId: 'delivery-123',
      event: 'installation',
    });
  });

  it('enqueues installation_repositories added event successfully', async () => {
    // 65 repositories added
    const mockReposAdded = Array.from({ length: 65 }, (_, i) => ({
      id: 2000 + i,
      full_name: `org/new-repo-${i}`,
    }));

    vi.mocked(prisma.webhookEvent.findUnique).mockResolvedValue(null);

    const payload = {
      action: 'added',
      installation: { id: 12345 },
      repositories_added: mockReposAdded,
      sender: { id: 999 },
    };

    const req = new NextRequest('http://localhost/api/webhooks/github', {
      method: 'POST',
      headers: {
        'x-github-event': 'installation_repositories',
        'x-github-delivery': 'delivery-456',
        'x-hub-signature-256': 'sha256=mock-signature',
      },
      body: JSON.stringify(payload),
    });

    const response = await POST(req as any);

    // Verify response
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ status: 'queued' });

    // Verify event is saved in database
    expect(prisma.webhookEvent.create).toHaveBeenCalledWith({
      data: {
        deliveryId: 'delivery-456',
        repositoryId: undefined,
        pullRequestId: undefined,
      },
    });

    // Verify background job was enqueued
    expect(addWebhookJob).toHaveBeenCalledWith({
      payload,
      deliveryId: 'delivery-456',
      event: 'installation_repositories',
    });
  });

  it('enqueues pull_request event successfully', async () => {
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
    vi.mocked(prisma.pullRequest.findUnique).mockResolvedValue({
      id: 'pr-db-id',
    } as any);

    const payload = {
      action: 'opened',
      installation: { id: 12345 },
      repository: mockRepo,
      pull_request: mockPR,
    };

    const req = new NextRequest('http://localhost/api/webhooks/github', {
      method: 'POST',
      headers: {
        'x-github-event': 'pull_request',
        'x-github-delivery': 'delivery-789',
        'x-hub-signature-256': 'sha256=mock-signature',
      },
      body: JSON.stringify(payload),
    });

    const response = await POST(req as any);

    // Check response status and body
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ status: 'queued' });

    // Verify event is saved in database linking repo and PR
    expect(prisma.webhookEvent.create).toHaveBeenCalledWith({
      data: {
        deliveryId: 'delivery-789',
        repositoryId: 'repo-db-id',
        pullRequestId: 'pr-db-id',
      },
    });

    // Verify background job was enqueued
    expect(addWebhookJob).toHaveBeenCalledWith({
      payload,
      deliveryId: 'delivery-789',
      event: 'pull_request',
    });
  });
});
