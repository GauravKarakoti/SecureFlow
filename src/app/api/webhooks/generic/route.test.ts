import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createHmac } from 'crypto';

// ---- Mocks ----

vi.mock('@/lib/middleware/error-handler', () => {
  const AppError = class AppError extends Error {
    statusCode: number;
    constructor(msg: string, code = 400) {
      super(msg);
      this.statusCode = code;
    }
  };
  return {
    withErrorHandler:
      (fn: (...args: unknown[]) => unknown) =>
      async (...args: unknown[]) => {
        try {
          return await fn(...args);
        } catch (err: unknown) {
          const e = err as { statusCode?: number; message?: string };
          return { status: e.statusCode || 500, json: async () => ({ error: e.message }) };
        }
      },
    AppError,
  };
});

/**
 * Captures the config each route hands to `withRateLimit`.
 *
 * `vi.hoisted` because `vi.mock` factories run before the module body, and the
 * route modules call `withRateLimit` at import time.
 */
const { rateLimitConfigs } = vi.hoisted(() => ({
  rateLimitConfigs: [] as Array<{ keyPrefix: string; limit: number; windowSeconds: number }>,
}));

vi.mock('@/lib/middleware/rate-limit', () => ({
  withRateLimit: <T>(handler: T, config: { keyPrefix: string; limit: number; windowSeconds: number }): T => {
    rateLimitConfigs.push(config);
    return handler;
  },
}));

// ---- Imports (after mocks) ----

import { POST as GENERIC_POST } from '@/app/api/webhooks/generic/route';
import { POST as DEFAULT_POST } from '@/app/api/webhooks/route';

const GENERIC_SECRET = 'generic-secret-key-12345';

function makeRequest(
  body: string,
  { secret = GENERIC_SECRET, extraHeaders = {} }: { secret?: string; extraHeaders?: Record<string, string> } = {}
) {
  const signature = `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`;

  return new Request('http://localhost:3000/api/webhooks/generic', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-SecureFlow-Signature': signature,
      'X-SecureFlow-Timestamp': Math.floor(Date.now() / 1000).toString(),
      ...extraHeaders,
    },
    body,
  });
}

describe('/api/webhooks/generic', () => {
  beforeEach(() => {
    process.env.GENERIC_WEBHOOK_SECRET = GENERIC_SECRET;
    process.env.WEBHOOK_SECRET = 'default-secret-key-12345';
  });

  it('accepts a valid signed ping', async () => {
    const res = await GENERIC_POST(makeRequest(JSON.stringify({ event: 'ping' })) as never);

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ status: 'pong', message: 'Webhook verified' });
  });

  it('accepts an alert', async () => {
    const res = await GENERIC_POST(
      makeRequest(JSON.stringify({ event: 'alert', severity: 'high' })) as never
    );

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({ status: 'received' });
  });

  it('reads the event from the x-webhook-event header', async () => {
    const res = await GENERIC_POST(
      makeRequest('{}', { extraHeaders: { 'x-webhook-event': 'ping' } }) as never
    );

    await expect(res.json()).resolves.toMatchObject({ status: 'pong' });
  });

  it('acknowledges an unknown event without echoing its name', async () => {
    const res = await GENERIC_POST(
      makeRequest(JSON.stringify({ event: '<script>alert(1)</script>' })) as never
    );

    const body = await res.json();
    expect(body).toEqual({ status: 'received', message: 'Webhook acknowledged' });
    expect(JSON.stringify(body)).not.toContain('script');
  });

  it('rejects a signature made with the default endpoint secret', async () => {
    // The point of a second endpoint: the two secrets are not interchangeable.
    const res = await GENERIC_POST(
      makeRequest(JSON.stringify({ event: 'ping' }), { secret: 'default-secret-key-12345' }) as never
    );

    expect(res.status).toBe(401);
  });

  it('rejects an unsigned request', async () => {
    const body = JSON.stringify({ event: 'ping' });
    const req = new Request('http://localhost:3000/api/webhooks/generic', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-SecureFlow-Timestamp': Math.floor(Date.now() / 1000).toString(),
      },
      body,
    });

    expect((await GENERIC_POST(req as never)).status).toBe(401);
  });

  it('rejects a stale request', async () => {
    const body = JSON.stringify({ event: 'ping' });
    const req = new Request('http://localhost:3000/api/webhooks/generic', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-SecureFlow-Signature': `sha256=${createHmac('sha256', GENERIC_SECRET).update(body).digest('hex')}`,
        'X-SecureFlow-Timestamp': Math.floor((Date.now() - 600_000) / 1000).toString(),
      },
      body,
    });

    expect((await GENERIC_POST(req as never)).status).toBe(401);
  });

  it('rejects malformed JSON', async () => {
    const res = await GENERIC_POST(makeRequest('not json at all') as never);

    expect(res.status).toBe(400);
  });

  it('rejects a JSON body that is not an object', async () => {
    // `JSON.parse` accepts these; `parsed.event` on a string returns a
    // character, so they are refused before they reach the dispatch.
    for (const body of ['null', '7', '"alert"', '[1,2,3]']) {
      expect((await GENERIC_POST(makeRequest(body) as never)).status).toBe(400);
    }
  });
});

describe('rate-limit buckets (#720)', () => {
  it('gives the two webhook routes separate keys', () => {
    // Both shipped with `webhook:generic`. `withRateLimit` keys on
    // `rate-limit:${keyPrefix}:${ip}`, so one endpoint's traffic spent the
    // other's budget and 100 requests to either locked out both.
    const prefixes = rateLimitConfigs.map((c) => c.keyPrefix);

    expect(prefixes).toHaveLength(2);
    expect(new Set(prefixes).size).toBe(2);
    expect(prefixes).toEqual(expect.arrayContaining(['webhook:default', 'webhook:generic']));
  });

  it('keeps both endpoints at 100 requests per minute', () => {
    for (const config of rateLimitConfigs) {
      expect(config.limit).toBe(100);
      expect(config.windowSeconds).toBe(60);
    }
  });

  it('exports a POST from each route', () => {
    expect(typeof GENERIC_POST).toBe('function');
    expect(typeof DEFAULT_POST).toBe('function');
  });
});
