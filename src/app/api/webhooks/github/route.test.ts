import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { POST } from './route';
import prisma from '@/lib/prisma';

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
      },
      repository: {
        upsert: vi.fn(),
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
    vi.mocked(prisma.account.findFirst).mockResolvedValue(mockAccount);
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
    vi.mocked(prisma.account.findFirst).mockResolvedValue(mockAccount);
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
});
