import { describe, it, expect } from 'vitest';
import { createHmac } from 'crypto';
import {
  DEFAULT_MAX_WEBHOOK_BYTES,
  TRACKED_EVENTS,
  admitWebhook,
  isPayloadTooLarge,
  isTrackedEvent,
  normalizeDeliveryId,
  parseGithubSignature,
  parseMaxWebhookBytes,
  parseWebhookPayload,
  payloadByteLength,
  verifySignature,
  webhookJobId,
} from './webhook-verification';

const SECRET = 'test-webhook-secret';
const BODY = JSON.stringify({ action: 'opened', repository: { full_name: 'org/repo' } });

function sign(body: string, secret = SECRET): string {
  return `sha256=${createHmac('sha256', secret).update(body, 'utf8').digest('hex')}`;
}

describe('parseGithubSignature', () => {
  it('extracts the digest from a well-formed header', () => {
    const header = sign(BODY);
    expect(parseGithubSignature(header)).toBe(header.slice('sha256='.length));
  });

  it('lowercases the digest so casing cannot produce a mismatch', () => {
    const hex = 'A'.repeat(64);
    expect(parseGithubSignature(`sha256=${hex}`)).toBe('a'.repeat(64));
  });

  it.each([
    ['missing header', null],
    ['undefined header', undefined],
    ['empty string', ''],
    ['wrong algorithm prefix', `md5=${'a'.repeat(64)}`],
    ['no prefix at all', 'a'.repeat(64)],
    ['digest too short', `sha256=${'a'.repeat(63)}`],
    ['digest too long', `sha256=${'a'.repeat(65)}`],
  ])('rejects %s', (_label, header) => {
    expect(parseGithubSignature(header as string | null)).toBeNull();
  });

  it('rejects a non-hex digest instead of letting Buffer.from truncate it', () => {
    // Buffer.from('zz…', 'hex') silently returns a zero-length buffer. Relying
    // on a downstream length check to compensate for an unvalidated parse is
    // the kind of thing that breaks when the downstream check moves.
    expect(parseGithubSignature(`sha256=${'z'.repeat(64)}`)).toBeNull();
    expect(parseGithubSignature(`sha256=${'a'.repeat(63)}g`)).toBeNull();
  });

  it('rejects a non-string header', () => {
    expect(parseGithubSignature(42 as unknown as string)).toBeNull();
  });
});

describe('verifySignature', () => {
  it('accepts a signature produced with the same secret', () => {
    const hex = parseGithubSignature(sign(BODY))!;
    expect(verifySignature(BODY, SECRET, hex)).toBe(true);
  });

  it('rejects a signature produced with a different secret', () => {
    const hex = parseGithubSignature(sign(BODY, 'other-secret'))!;
    expect(verifySignature(BODY, SECRET, hex)).toBe(false);
  });

  it('rejects when a single byte of the body changed', () => {
    const hex = parseGithubSignature(sign(BODY))!;
    expect(verifySignature(`${BODY} `, SECRET, hex)).toBe(false);
  });

  it('handles multi-byte characters, which byte length and string length disagree on', () => {
    const body = JSON.stringify({ repo: 'café-☕-repo' });
    const hex = parseGithubSignature(sign(body))!;
    expect(verifySignature(body, SECRET, hex)).toBe(true);
  });

  it('returns false rather than throwing on a length mismatch', () => {
    // timingSafeEqual throws when the buffers differ in length.
    expect(() => verifySignature(BODY, SECRET, 'abcd')).not.toThrow();
    expect(verifySignature(BODY, SECRET, 'abcd')).toBe(false);
  });
});

describe('parseMaxWebhookBytes', () => {
  it('defaults when unset or blank', () => {
    expect(parseMaxWebhookBytes(undefined)).toBe(DEFAULT_MAX_WEBHOOK_BYTES);
    expect(parseMaxWebhookBytes('   ')).toBe(DEFAULT_MAX_WEBHOOK_BYTES);
  });

  it('accepts a positive integer', () => {
    expect(parseMaxWebhookBytes('1048576')).toBe(1048576);
  });

  it('falls back rather than accepting a value that would disable the cap', () => {
    expect(parseMaxWebhookBytes('0')).toBe(DEFAULT_MAX_WEBHOOK_BYTES);
    expect(parseMaxWebhookBytes('-1')).toBe(DEFAULT_MAX_WEBHOOK_BYTES);
    expect(parseMaxWebhookBytes('lots')).toBe(DEFAULT_MAX_WEBHOOK_BYTES);
    expect(parseMaxWebhookBytes('1.5')).toBe(DEFAULT_MAX_WEBHOOK_BYTES);
  });
});

describe('isPayloadTooLarge', () => {
  it('rejects a body over the cap', () => {
    expect(isPayloadTooLarge(2048, 1024)).toBe(true);
    expect(isPayloadTooLarge('2048', 1024)).toBe(true);
  });

  it('accepts a body exactly at the cap', () => {
    expect(isPayloadTooLarge(1024, 1024)).toBe(false);
  });

  it('does not reject when Content-Length is absent', () => {
    // A chunked request legitimately omits it, which is exactly why the caller
    // re-checks the real byte length after reading.
    expect(isPayloadTooLarge(null, 1024)).toBe(false);
    expect(isPayloadTooLarge(undefined, 1024)).toBe(false);
  });

  it('ignores an unparseable or negative Content-Length', () => {
    expect(isPayloadTooLarge('not-a-number', 1024)).toBe(false);
    expect(isPayloadTooLarge('-5', 1024)).toBe(false);
  });
});

describe('payloadByteLength', () => {
  it('counts bytes, not characters', () => {
    expect(payloadByteLength('abc')).toBe(3);
    expect(payloadByteLength('☕')).toBe(3);
    expect('☕'.length).toBe(1);
  });
});

describe('parseWebhookPayload', () => {
  it('returns the parsed object', () => {
    const result = parseWebhookPayload('{"action":"opened"}');
    expect(result).toEqual({ ok: true, payload: { action: 'opened' } });
  });

  it('reports malformed JSON instead of throwing', () => {
    // Thrown, this was a bare SyntaxError with no statusCode, so the error
    // handler returned 500 — which GitHub retries, re-delivering a payload that
    // can never succeed.
    const result = parseWebhookPayload('{not json');
    expect(result.ok).toBe(false);
    expect(result).toHaveProperty('reason', 'Request body is not valid JSON');
  });

  it.each([
    ['null', 'null'],
    ['an array', '[]'],
    ['a number', '42'],
    ['a string', '"hello"'],
  ])('rejects %s, which is valid JSON but not an object', (_label, body) => {
    const result = parseWebhookPayload(body);
    expect(result.ok).toBe(false);
  });

  it('rejects an empty body', () => {
    expect(parseWebhookPayload('').ok).toBe(false);
  });
});

describe('isTrackedEvent', () => {
  it.each(TRACKED_EVENTS)('accepts %s', (event) => {
    expect(isTrackedEvent(event)).toBe(true);
  });

  it.each(['push', 'ping', 'issues', '', null, undefined])('rejects %j', (event) => {
    expect(isTrackedEvent(event as string | null)).toBe(false);
  });
});

describe('normalizeDeliveryId', () => {
  it('accepts the UUID GitHub sends', () => {
    expect(normalizeDeliveryId('72d3162e-cc78-11e3-81ab-4c9367dc0958')).toBe(
      '72d3162e-cc78-11e3-81ab-4c9367dc0958'
    );
  });

  it('trims surrounding whitespace', () => {
    expect(normalizeDeliveryId('  abc-123  ')).toBe('abc-123');
  });

  it.each([
    ['null', null],
    ['undefined', undefined],
    ['empty', ''],
    ['whitespace only', '   '],
  ])('rejects %s, which would disable the idempotency check', (_label, value) => {
    expect(normalizeDeliveryId(value as string | null)).toBeNull();
  });

  it('rejects characters that have no business in a job ID or a database key', () => {
    expect(normalizeDeliveryId('abc/../../etc')).toBeNull();
    expect(normalizeDeliveryId('abc\ndef')).toBeNull();
    expect(normalizeDeliveryId('abc def')).toBeNull();
  });

  it('rejects an absurdly long value', () => {
    expect(normalizeDeliveryId('a'.repeat(201))).toBeNull();
    expect(normalizeDeliveryId('a'.repeat(200))).toBe('a'.repeat(200));
  });
});

describe('webhookJobId', () => {
  it('is deterministic, so a replay collapses onto the original job', () => {
    expect(webhookJobId('abc-123')).toBe('delivery-abc-123');
    expect(webhookJobId('abc-123')).toBe(webhookJobId('abc-123'));
  });

  it('differs between deliveries', () => {
    expect(webhookJobId('a')).not.toBe(webhookJobId('b'));
  });
});

describe('admitWebhook', () => {
  const base = {
    payloadText: BODY,
    secret: SECRET,
    signatureHeader: sign(BODY),
    deliveryHeader: 'delivery-1',
  };

  it('admits a genuine delivery', () => {
    const result = admitWebhook(base);
    expect(result.ok).toBe(true);
    expect(result).toMatchObject({ deliveryId: 'delivery-1' });
  });

  it('rejects an oversized body with 413, before anything else', () => {
    const result = admitWebhook({ ...base, maxBytes: 4 });
    expect(result).toMatchObject({ ok: false, status: 413 });
  });

  it('reports a missing secret as a 500 deployment fault', () => {
    expect(admitWebhook({ ...base, secret: undefined })).toMatchObject({
      ok: false,
      status: 500,
    });
  });

  it('rejects a missing delivery header with 400', () => {
    expect(admitWebhook({ ...base, deliveryHeader: null })).toMatchObject({
      ok: false,
      status: 400,
    });
  });

  it('rejects a bad signature with 401', () => {
    expect(
      admitWebhook({ ...base, signatureHeader: `sha256=${'0'.repeat(64)}` })
    ).toMatchObject({ ok: false, status: 401 });
  });

  it('rejects malformed JSON with 400 rather than 500', () => {
    const body = '{not json';
    expect(
      admitWebhook({ ...base, payloadText: body, signatureHeader: sign(body) })
    ).toMatchObject({ ok: false, status: 400 });
  });

  it('checks the signature before the body is ever parsed', () => {
    // A malformed body with a bad signature must fail as unauthorised, not as
    // a parse error — otherwise the response distinguishes the two for someone
    // who holds neither.
    const body = '{not json';
    expect(
      admitWebhook({ ...base, payloadText: body, signatureHeader: `sha256=${'0'.repeat(64)}` })
    ).toMatchObject({ ok: false, status: 401 });
  });

  it('checks the size before the signature, so an oversized body is never hashed', () => {
    expect(
      admitWebhook({ ...base, maxBytes: 4, signatureHeader: `sha256=${'0'.repeat(64)}` })
    ).toMatchObject({ ok: false, status: 413 });
  });

  it('rejects a body whose Content-Length lied about being small', () => {
    expect(
      admitWebhook({ ...base, contentLength: '1', maxBytes: 4 })
    ).toMatchObject({ ok: false, status: 413 });
  });
});
