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

// ---- Imports (after mocks) ----

import { POST } from '@/app/api/webhooks/github/route';
import { addWebhookJob } from '@/lib/queue/webhookQueue';

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
  });

  describe('signature verification (x-hub-signature-256)', () => {
    it('returns 401 Unauthorized when the signature header is missing completely', async () => {
      const req = makeRequest(minimalPRPayload, { 'x-hub-signature-256': '' });
      const res = await POST(req);
      expect(res.status).toBe(401);
      expect(await res.json()).toEqual({ error: 'Missing or invalid x-hub-signature-256 header' });
    });

    it('returns 401 Unauthorized when the signature header format is malformed (missing sha256= prefix)', async () => {
      const req = makeRequest(minimalPRPayload, { 'x-hub-signature-256': 'md5=1234567890abcdef' });
      const res = await POST(req);
      expect(res.status).toBe(401);
      expect(await res.json()).toEqual({ error: 'Missing or invalid x-hub-signature-256 header' });
    });

    it('returns 401 Unauthorized when the signature HMAC digest does not match the payload', async () => {
      const wrongSignature = 'sha256=0000000000000000000000000000000000000000000000000000000000000000';
      const req = makeRequest(minimalPRPayload, { 'x-hub-signature-256': wrongSignature });
      const res = await POST(req);
      expect(res.status).toBe(401);
      expect(await res.json()).toEqual({ error: 'Invalid GitHub webhook signature' });
    });
  });

  it('returns 202 and queues the job for a valid pull_request event', async () => {
    const req = makeRequest(minimalPRPayload);
    const res = await POST(req);
    expect(res.status).toBe(202);
    expect(addWebhookJob).toHaveBeenCalledOnce();
  });

  it('returns 200 but does NOT queue for an untracked event type', async () => {
    const req = makeRequest(minimalPRPayload, {}, 'push');
    const res = await POST(req);
    expect(res.status).toBe(200);
    expect(addWebhookJob).not.toHaveBeenCalled();
  });

  it('returns 202 and queues installation events', async () => {
    const body = JSON.stringify({ action: 'created', installation: { id: 1 }, sender: { id: 2 } });
    const req = makeRequest(body, {}, 'installation');
    const res = await POST(req);
    expect(res.status).toBe(202);
    expect(addWebhookJob).toHaveBeenCalledOnce();
  });

  it('returns 202 and queues installation_repositories events', async () => {
    const body = JSON.stringify({
      action: 'added',
      installation: { id: 1 },
      repositories_added: [],
      sender: { id: 2 },
    });
    const req = makeRequest(body, {}, 'installation_repositories');
    const res = await POST(req);
    expect(res.status).toBe(202);
    expect(addWebhookJob).toHaveBeenCalledOnce();
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