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
  overrides: Record<string, string | null> = {},
  event = 'pull_request'
) {
  const headers: Record<string, string | null> = {
    'x-hub-signature-256': sign(body),
    'x-github-event': event,
    'x-github-delivery': 'delivery-' + Math.random().toString(36).slice(2),
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
    delete process.env.GITHUB_WEBHOOK_MAX_BYTES;
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
      const wrongSignature = 'sha256=' + '0'.repeat(64);
      const req = makeRequest(minimalPRPayload, { 'x-hub-signature-256': wrongSignature });
      const res = await POST(req);
      expect(res.status).toBe(401);
      expect(await res.json()).toEqual({ error: 'Invalid GitHub webhook signature' });
    });

    it('verifies before dispatching on the event type (#562)', async () => {
      // The old route filtered on x-github-event first, so an unauthenticated
      // caller sending `x-github-event: push` got a 200 "Event not tracked" --
      // an oracle distinguishing "endpoint exists" from "signature rejected",
      // and a free unauthenticated 200 responder.
      const req = makeRequest(
        minimalPRPayload,
        { 'x-hub-signature-256': 'sha256=' + '0'.repeat(64) },
        'push'
      );
      const res = await POST(req);
      expect(res.status).toBe(401);
      expect(addWebhookJob).not.toHaveBeenCalled();
    });
  });

  describe('delivery identity (#562)', () => {
    it('returns 400 when x-github-delivery is missing', async () => {
      // The worker guards its idempotency check on this value being truthy, so
      // forwarding null silently disabled duplicate detection -- and with
      // attempts: 3, a late failure re-ran the whole scan on every retry.
      const req = makeRequest(minimalPRPayload, { 'x-github-delivery': null });
      const res = await POST(req);
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: 'Missing or invalid x-github-delivery header' });
      expect(addWebhookJob).not.toHaveBeenCalled();
    });

    it('returns 400 for a delivery id containing characters that cannot be a job id', async () => {
      const req = makeRequest(minimalPRPayload, { 'x-github-delivery': 'abc/../../etc' });
      const res = await POST(req);
      expect(res.status).toBe(400);
    });

    it('enqueues with a deterministic job id so a replay collapses in the queue', async () => {
      const req = makeRequest(minimalPRPayload, { 'x-github-delivery': 'delivery-xyz' });
      await POST(req);

      expect(addWebhookJob).toHaveBeenCalledWith(
        expect.objectContaining({ deliveryId: 'delivery-xyz', event: 'pull_request' }),
        { jobId: 'delivery-delivery-xyz' }
      );
    });
  });

  describe('payload parsing (#562)', () => {
    it('returns 400, not 500, for a verified body that is not valid JSON', async () => {
      // A bare SyntaxError carries no statusCode, so the error handler used to
      // return 500 -- which GitHub treats as retryable, re-delivering a payload
      // that can never succeed.
      const body = '{not json';
      const req = makeRequest(body, { 'x-hub-signature-256': sign(body) });
      const res = await POST(req);
      expect(res.status).toBe(400);
      expect(addWebhookJob).not.toHaveBeenCalled();
    });

    it('returns 400 for valid JSON that is not an object', async () => {
      const body = '[]';
      const req = makeRequest(body, { 'x-hub-signature-256': sign(body) });
      const res = await POST(req);
      expect(res.status).toBe(400);
    });
  });

  describe('body size limit (#562)', () => {
    it('returns 413 from Content-Length before the body is read', async () => {
      process.env.GITHUB_WEBHOOK_MAX_BYTES = '16';
      let readCount = 0;
      const req = makeRequest(minimalPRPayload, { 'content-length': '999999' });
      const original = req.text;
      req.text = async () => {
        readCount += 1;
        return original();
      };

      const res = await POST(req);

      expect(res.status).toBe(413);
      expect(readCount).toBe(0);
    });

    it('returns 413 when Content-Length lied about being small', async () => {
      // Content-Length is attacker-supplied, so the real byte length is
      // re-checked after reading.
      process.env.GITHUB_WEBHOOK_MAX_BYTES = '16';
      const req = makeRequest(minimalPRPayload, { 'content-length': '1' });
      const res = await POST(req);
      expect(res.status).toBe(413);
      expect(addWebhookJob).not.toHaveBeenCalled();
    });

    it('accepts a normal payload under the default cap', async () => {
      const req = makeRequest(minimalPRPayload);
      const res = await POST(req);
      expect(res.status).toBe(202);
    });
  });

  describe('event dispatch', () => {
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

    it('answers ping only after verifying the signature (#562)', async () => {
      // ping is GitHub's first delivery when a webhook is registered. Answering
      // it before verification meant a webhook configured with the wrong secret
      // still looked healthy in the GitHub UI.
      const req = makeRequest(minimalPRPayload, {}, 'ping');
      const res = await POST(req);
      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({ status: 'pong' });
      expect(addWebhookJob).not.toHaveBeenCalled();
    });

    it('rejects an unsigned ping', async () => {
      const req = makeRequest(
        minimalPRPayload,
        { 'x-hub-signature-256': 'sha256=' + '0'.repeat(64) },
        'ping'
      );
      const res = await POST(req);
      expect(res.status).toBe(401);
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

    it('returns 202 and queues pull_request synchronize events', async () => {
      const body = JSON.stringify({
        action: 'synchronize',
        number: 42,
        pull_request: { head: { sha: 'abcdef123456' } },
        repository: { full_name: 'org/repo' },
      });
      const req = makeRequest(body, {}, 'pull_request');
      const res = await POST(req);
      expect(res.status).toBe(202);
      expect(addWebhookJob).toHaveBeenCalledOnce();
    });

    it('returns 202 and queues branch_protection_rule events', async () => {
      const body = JSON.stringify({
        action: 'created',
        rule: { name: 'main' },
        repository: { full_name: 'org/repo' },
      });
      const req = makeRequest(body, {}, 'branch_protection_rule');
      const res = await POST(req);
      expect(res.status).toBe(202);
      expect(addWebhookJob).toHaveBeenCalledOnce();
    });

    it('passes the delivery ID and event type to the queue', async () => {
      const deliveryId = 'unique-delivery-xyz';
      const req = makeRequest(minimalPRPayload, { 'x-github-delivery': deliveryId });
      await POST(req);
      expect(addWebhookJob).toHaveBeenCalledWith(
        expect.objectContaining({ deliveryId, event: 'pull_request' }),
        expect.objectContaining({ jobId: `delivery-${deliveryId}` })
      );
    });
  });

  describe('deployment faults', () => {
    it('returns 500 when GITHUB_WEBHOOK_SECRET is not configured', async () => {
      delete process.env.GITHUB_WEBHOOK_SECRET;
      const req = makeRequest(minimalPRPayload);
      const res = await POST(req);
      expect(res.status).toBe(500);
      expect(addWebhookJob).not.toHaveBeenCalled();
    });
  });
});
