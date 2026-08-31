import { describe, it, expect, vi } from 'vitest';
import { NextRequest, NextResponse } from 'next/server';

import {
  isUsableSecret,
  signOutboundWebhook,
  verifyWebhookRequest,
  withWebhookGuard,
} from './webhookGuard';
import { signPayload, SIGNATURE_HEADER, TIMESTAMP_HEADER } from './hmacSigner';

const SECRET = 'test-webhook-secret';

function makeRequest(
  body: string,
  {
    secret = SECRET,
    timestampSeconds = Math.floor(Date.now() / 1000),
    signature,
    omit = [],
  }: {
    secret?: string;
    timestampSeconds?: number;
    signature?: string;
    omit?: Array<'signature' | 'timestamp'>;
  } = {}
): NextRequest {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };

  if (!omit.includes('signature')) {
    headers[SIGNATURE_HEADER] = signature ?? signPayload(body, secret);
  }
  if (!omit.includes('timestamp')) {
    headers[TIMESTAMP_HEADER] = String(timestampSeconds);
  }

  return new NextRequest('https://securefl.ow/api/webhooks', {
    method: 'POST',
    headers,
    body,
  });
}

/** A handler that records what it was called with and echoes the payload. */
function recordingHandler() {
  const calls: string[] = [];
  const handler = vi.fn(async (_req: NextRequest, payload: string) => {
    calls.push(payload);
    return NextResponse.json({ received: true }, { status: 200 });
  });
  return { handler, calls };
}

describe('isUsableSecret', () => {
  it('accepts a non-blank string', () => {
    expect(isUsableSecret('s3cret')).toBe(true);
  });

  it('rejects undefined, null and non-strings', () => {
    expect(isUsableSecret(undefined)).toBe(false);
    expect(isUsableSecret(null)).toBe(false);
    expect(isUsableSecret(12345)).toBe(false);
    expect(isUsableSecret({})).toBe(false);
  });

  it('rejects the empty string', () => {
    expect(isUsableSecret('')).toBe(false);
  });

  it('rejects whitespace-only, which is what a stray trailing space in .env looks like', () => {
    expect(isUsableSecret(' ')).toBe(false);
    expect(isUsableSecret('\t\n  ')).toBe(false);
  });
});

describe('withWebhookGuard — fail closed without a secret (#718)', () => {
  it('refuses a forged signature computed under the empty key', async () => {
    // The bug: Node accepts an empty HMAC key, so `createHmac('sha256', '')`
    // is an ordinary keyed digest that anyone can compute -- the key is public
    // knowledge. Verifying against it admits every request.
    const body = JSON.stringify({ event: 'ping' });
    const forged = signPayload(body, '');
    const { handler } = recordingHandler();

    const guarded = withWebhookGuard(handler, { secret: '' });
    const res = await guarded(makeRequest(body, { signature: forged }));

    expect(res.status).toBe(500);
    expect(handler).not.toHaveBeenCalled();
    await expect(res.json()).resolves.toEqual({
      error: 'Webhook endpoint is not configured for signature verification',
    });
  });

  it('refuses when the secret is undefined', async () => {
    const { handler } = recordingHandler();
    const guarded = withWebhookGuard(handler, { secret: undefined });

    const res = await guarded(makeRequest('{}'));

    expect(res.status).toBe(500);
    expect(handler).not.toHaveBeenCalled();
  });

  it('refuses when the secret is whitespace only', async () => {
    const { handler } = recordingHandler();
    const guarded = withWebhookGuard(handler, { secret: '   ' });

    expect((await guarded(makeRequest('{}'))).status).toBe(500);
    expect(handler).not.toHaveBeenCalled();
  });

  it('does not name the environment variable in the error body', async () => {
    const guarded = withWebhookGuard(recordingHandler().handler, { secret: '' });
    const body = await (await guarded(makeRequest('{}'))).json();

    expect(JSON.stringify(body)).not.toMatch(/SECRET/i);
  });

  it('routes the misconfiguration through onError when one is supplied', async () => {
    const onError = vi.fn(() => NextResponse.json({ custom: true }, { status: 503 }));
    const guarded = withWebhookGuard(recordingHandler().handler, { secret: '', onError });

    const res = await guarded(makeRequest('{}'));

    expect(res.status).toBe(503);
    expect(onError).toHaveBeenCalledWith({
      status: 500,
      message: 'Webhook endpoint is not configured for signature verification',
    });
  });
});

describe('withWebhookGuard — admission', () => {
  it('admits a correctly signed request and hands the handler the raw body', async () => {
    const body = JSON.stringify({ event: 'ping', nested: { n: 1 } });
    const { handler, calls } = recordingHandler();

    const res = await withWebhookGuard(handler, { secret: SECRET })(makeRequest(body));

    expect(res.status).toBe(200);
    expect(calls).toEqual([body]);
  });

  it('gives the handler the bytes as sent, not a re-serialised object', async () => {
    // The signature is over raw bytes, so key order and spacing have to
    // survive: a handler that re-signs or forwards must see what was signed.
    const body = '{"b":2,  "a":1}';
    const { handler, calls } = recordingHandler();

    await withWebhookGuard(handler, { secret: SECRET })(makeRequest(body));

    expect(calls[0]).toBe(body);
  });

  it('rejects a signature made with the wrong secret', async () => {
    const body = '{}';
    const { handler } = recordingHandler();

    const res = await withWebhookGuard(handler, { secret: SECRET })(
      makeRequest(body, { secret: 'not-the-secret' })
    );

    expect(res.status).toBe(401);
    expect(handler).not.toHaveBeenCalled();
  });

  it('rejects a missing signature header', async () => {
    const res = await withWebhookGuard(recordingHandler().handler, { secret: SECRET })(
      makeRequest('{}', { omit: ['signature'] })
    );

    expect(res.status).toBe(401);
    await expect(res.json()).resolves.toMatchObject({ error: expect.stringContaining('signature') });
  });

  it('rejects a missing timestamp header', async () => {
    const res = await withWebhookGuard(recordingHandler().handler, { secret: SECRET })(
      makeRequest('{}', { omit: ['timestamp'] })
    );

    expect(res.status).toBe(401);
  });

  it('rejects a stale request', async () => {
    const res = await withWebhookGuard(recordingHandler().handler, { secret: SECRET })(
      makeRequest('{}', { timestampSeconds: Math.floor(Date.now() / 1000) - 600 })
    );

    expect(res.status).toBe(401);
  });

  it('honours a custom replay window', async () => {
    const body = '{}';
    const thirtySecondsAgo = Math.floor(Date.now() / 1000) - 30;

    const wide = await withWebhookGuard(recordingHandler().handler, {
      secret: SECRET,
      replayWindowSeconds: 60,
    })(makeRequest(body, { timestampSeconds: thirtySecondsAgo }));
    expect(wide.status).toBe(200);

    const narrow = await withWebhookGuard(recordingHandler().handler, {
      secret: SECRET,
      replayWindowSeconds: 10,
    })(makeRequest(body, { timestampSeconds: thirtySecondsAgo }));
    expect(narrow.status).toBe(401);
  });

  it('reads a getter secret per request, not once at wrapper construction', async () => {
    // A serverless runtime can import the module before the environment is
    // complete. Pinning the value read at construction time is how an endpoint
    // ends up permanently unconfigured after a cold start.
    const reads: number[] = [];
    let current: string | undefined = undefined;
    const options = {
      get secret() {
        reads.push(reads.length);
        return current;
      },
    };
    const guarded = withWebhookGuard(recordingHandler().handler, options);

    expect((await guarded(makeRequest('{}'))).status).toBe(500);

    current = SECRET;
    expect((await guarded(makeRequest('{}'))).status).toBe(200);
    expect(reads.length).toBeGreaterThanOrEqual(2);
  });
});

describe('verifyWebhookRequest', () => {
  it('returns the verified payload, because the caller can no longer read it', async () => {
    // The bug: this used to return `null` on success having already spent the
    // request's single-use body stream, so the documented usage -- verify,
    // then read the body -- could not work.
    const body = JSON.stringify({ event: 'alert', severity: 'high' });

    const check = await verifyWebhookRequest(makeRequest(body), SECRET);

    expect(check.ok).toBe(true);
    if (check.ok) {
      expect(check.payload).toBe(body);
      expect(JSON.parse(check.payload)).toEqual({ event: 'alert', severity: 'high' });
      expect(check.error).toBeNull();
    }
  });

  it('confirms the request body really is spent afterwards', async () => {
    // Proves the payload has to be returned: there is nothing left to read.
    const body = '{"event":"ping"}';
    const req = makeRequest(body);

    await verifyWebhookRequest(req, SECRET);

    const second = await req.text().catch(() => '<<throws>>');
    expect(second).not.toBe(body);
  });

  it('reports a misconfigured secret as 500 without touching the body', async () => {
    const check = await verifyWebhookRequest(makeRequest('{}'), '');

    expect(check.ok).toBe(false);
    if (!check.ok) {
      expect(check.error.status).toBe(500);
      expect(check.payload).toBeNull();
    }
  });

  it('reports a bad signature as 401', async () => {
    const check = await verifyWebhookRequest(makeRequest('{}', { secret: 'wrong' }), SECRET);

    expect(check.ok).toBe(false);
    if (!check.ok) expect(check.error.status).toBe(401);
  });

  it('reports a stale request as 401', async () => {
    const check = await verifyWebhookRequest(
      makeRequest('{}', { timestampSeconds: Math.floor(Date.now() / 1000) - 600 }),
      SECRET
    );

    expect(check.ok).toBe(false);
    if (!check.ok) expect(check.error.status).toBe(401);
  });

  it('honours custom header names', async () => {
    const body = '{}';
    const req = new NextRequest('https://securefl.ow/api/webhooks', {
      method: 'POST',
      headers: {
        'X-Vendor-Signature': signPayload(body, SECRET),
        'X-Vendor-Timestamp': String(Math.floor(Date.now() / 1000)),
      },
      body,
    });

    const check = await verifyWebhookRequest(req, SECRET, {
      signatureHeader: 'X-Vendor-Signature',
      timestampHeader: 'X-Vendor-Timestamp',
    });

    expect(check.ok).toBe(true);
  });
});

describe('signOutboundWebhook', () => {
  it('sets the signature, timestamp and content type', () => {
    const body = '{"event":"scan.completed"}';
    const headers = signOutboundWebhook(body, SECRET);

    expect(headers.get(SIGNATURE_HEADER)).toBeTruthy();
    expect(headers.get(TIMESTAMP_HEADER)).toMatch(/^\d+$/);
    expect(headers.get('Content-Type')).toBe('application/json');
  });

  it('produces a signature the guard accepts', async () => {
    const body = '{"event":"scan.completed"}';
    const signed = signOutboundWebhook(body, SECRET);
    const { handler } = recordingHandler();

    const req = new NextRequest('https://securefl.ow/api/webhooks', {
      method: 'POST',
      headers: signed,
      body,
    });

    expect((await withWebhookGuard(handler, { secret: SECRET })(req)).status).toBe(200);
  });

  it('keeps extra headers', () => {
    const headers = signOutboundWebhook('{}', SECRET, { 'X-Webhook-Event': 'alert' });

    expect(headers.get('X-Webhook-Event')).toBe('alert');
  });

  it('refuses to sign without a secret rather than emitting a fake signature', () => {
    // A delivery signed under the empty key looks authenticated and is not,
    // which is worse for the receiver than no signature header at all.
    expect(() => signOutboundWebhook('{}', '')).toThrow(/without a secret/);
    expect(() => signOutboundWebhook('{}', undefined)).toThrow(/without a secret/);
    expect(() => signOutboundWebhook('{}', '   ')).toThrow(/without a secret/);
  });
});
