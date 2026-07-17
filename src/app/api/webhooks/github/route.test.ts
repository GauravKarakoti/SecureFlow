import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createHmac } from 'crypto';

// ---- Mocks (factories must not reference outer variables — they are hoisted) ----

vi.mock('@/lib/queue/webhookQueue', () => ({ addWebhookJob: vi.fn(async () => {}) }));

vi.mock('@/lib/middleware/error-handler', () => {
  const AppError = class AppError extends Error {
    statusCode: number;
    constructor(msg: string, code = 400) {
      super(msg);
      this.statusCode = code;
    }
  };
  return {
    withErrorHandler: (fn: (...args: unknown[]) => unknown) =>
      async (...args: unknown[]) => {
        try {
          return await fn(...args);
        } catch (err: unknown) {
          const e = err as { statusCode?: number; message?: string };
          return {
            status: e.statusCode || 500,
            json: async () => ({ error: e.message }),
          };
        }
      },
    AppError,
  };
});

vi.mock('@/lib/middleware/rateLimit', () => ({
  withRateLimit: <T extends (...args: unknown[]) => unknown>(handler: T): T => handler,
}));

vi.mock('@/lib/prisma', () => ({
  default: {
    webhookEvent: {
      findUnique: vi.fn(async () => null),
      create: vi.fn(async () => ({})),
    },
    repository: { findUnique: vi.fn(async () => null) },
    pullRequest: { findUnique: vi.fn(async () => null) },
  },
}));

// ---- Imports (after mocks) ----

import { POST } from '@/app/api/webhooks/github/route';
import { addWebhookJob } from '@/lib/queue/webhookQueue';
import prisma from '@/lib/prisma';

// ---- Helpers ----

const SECRET = 'test-webhook-secret';

function sign(body: string) {
  return 'sha256=' + createHmac('sha256', SECRET).update(body).digest('hex');
}

function makeRequest(
  body: string,
  overrides: Record<string, string> = {},
  event = 'pull_request'
) {
  const headers: Record<string, string> = {
    'x-hub-signature-256': sign(body),
    'x-github-event': event,
    'x-github-delivery': 'delivery-' + Math.random(),
    'content-type': 'application/json',
    ...overrides,
  };
  return {
    headers: { get: (k: string) => headers[k] ?? null },
    text: async () => body,
  } as any;
}

const minimalPRPayload = JSON.stringify({
  action: 'opened',
  pull_request: { id: 1, number: 1, head: { sha: 'abc' }, user: { login: 'dev' } },
  repository: { id: 42, full_name: 'org/repo' },
  installation: { id: 99 },
  sender: { id: 7 },
});

// ---- Tests ----

describe('GitHub webhook route', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.GITHUB_WEBHOOK_SECRET = SECRET;
    (prisma.webhookEvent.findUnique as any).mockResolvedValue(null);
  });

  it('returns 400 when the signature header is missing', async () => {
    const req = makeRequest(minimalPRPayload, { 'x-hub-signature-256': '' });
    const res = await POST(req);
    expect(res.status).toBe(400);
  });

  it('returns 401 when the signature is invalid', async () => {
    const req = makeRequest(minimalPRPayload, { 'x-hub-signature-256': 'sha256=badhex' });
    const res = await POST(req);
    expect(res.status).toBe(401);
  });

  it('returns 202 and skips processing for a duplicate delivery ID', async () => {
    (prisma.webhookEvent.findUnique as any).mockResolvedValue({ id: 'existing' });
    const req = makeRequest(minimalPRPayload);
    const res = await POST(req);
    expect(res.status).toBe(202);
    expect(addWebhookJob).not.toHaveBeenCalled();
  });

  it('returns 200 and queues the job for a valid pull_request event', async () => {
    const req = makeRequest(minimalPRPayload);
    const res = await POST(req);
    expect(res.status).toBe(200);
    expect(addWebhookJob).toHaveBeenCalledOnce();
  });

  it('returns 200 but does NOT queue for an untracked event type', async () => {
    const req = makeRequest(minimalPRPayload, {}, 'push');
    const res = await POST(req);
    expect(res.status).toBe(200);
    expect(addWebhookJob).not.toHaveBeenCalled();
  });

  it('queues installation events', async () => {
    const body = JSON.stringify({ action: 'created', installation: { id: 1 }, sender: { id: 2 } });
    const req = makeRequest(body, {}, 'installation');
    const res = await POST(req);
    expect(res.status).toBe(200);
    expect(addWebhookJob).toHaveBeenCalledOnce();
  });

  it('queues installation_repositories events', async () => {
    const body = JSON.stringify({
      action: 'added',
      installation: { id: 1 },
      repositories_added: [],
      sender: { id: 2 },
    });
    const req = makeRequest(body, {}, 'installation_repositories');
    const res = await POST(req);
    expect(res.status).toBe(200);
    expect(addWebhookJob).toHaveBeenCalledOnce();
  });

  it('returns 400 for a structurally invalid payload', async () => {
    // pull_request.number must be a number; passing a string triggers Zod failure
    const bad = JSON.stringify({ action: 'opened', pull_request: { id: 1, number: 'not-a-number' } });
    const req = makeRequest(bad);
    const res = await POST(req);
    expect(res.status).toBe(400);
  });

  it('creates a webhookEvent record for a new delivery', async () => {
    const req = makeRequest(minimalPRPayload);
    await POST(req);
    expect(prisma.webhookEvent.create).toHaveBeenCalledOnce();
  });

  it('passes the delivery ID and event type to the queue', async () => {
    const deliveryId = 'unique-delivery-xyz';
    const req = makeRequest(minimalPRPayload, { 'x-github-delivery': deliveryId });
    await POST(req);
    expect(addWebhookJob).toHaveBeenCalledWith(
      expect.objectContaining({ deliveryId, event: 'pull_request' })
    );
  });
});