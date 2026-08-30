import { describe, it, expect } from 'vitest';
import {
  signPayload,
  signPayloadV1,
  parseSignatureHeader,
  verifySignature,
  parseTimestamp,
  isWithinReplayWindow,
  admitWebhookRequest,
  SIGNATURE_HEADER,
  TIMESTAMP_HEADER,
  SIGNATURE_VERSION,
  DEFAULT_REPLAY_WINDOW_SECONDS,
} from './hmacSigner';
import {
  buildSignatureHeader,
  SIGNATURE_HEADER as OUTBOUND_SIGNATURE_HEADER,
  SIGNATURE_VERSION as OUTBOUND_SIGNATURE_VERSION,
  TIMESTAMP_HEADER as OUTBOUND_TIMESTAMP_HEADER,
} from '@/lib/queue/outbound-dispatch';

describe('signPayload', () => {
  it('produces a sha256= prefixed hex digest', () => {
    const sig = signPayload('hello', 'secret');
    expect(sig).toMatch(/^sha256=[0-9a-f]{64}$/);
  });

  it('produces consistent signatures for the same input', () => {
    const sig1 = signPayload('test', 'key');
    const sig2 = signPayload('test', 'key');
    expect(sig1).toBe(sig2);
  });

  it('produces different signatures for different payloads', () => {
    const sig1 = signPayload('payload-a', 'secret');
    const sig2 = signPayload('payload-b', 'secret');
    expect(sig1).not.toBe(sig2);
  });

  it('produces different signatures for different secrets', () => {
    const sig1 = signPayload('payload', 'secret-1');
    const sig2 = signPayload('payload', 'secret-2');
    expect(sig1).not.toBe(sig2);
  });
});

describe('verifySignature', () => {
  it('returns true for a valid signature', () => {
    const payload = 'test-payload';
    const secret = 'test-secret';
    const signature = signPayload(payload, secret);
    expect(verifySignature(payload, secret, signature)).toBe(true);
  });

  it('returns false for an invalid signature', () => {
    expect(verifySignature('payload', 'secret', 'sha256=' + 'a'.repeat(64))).toBe(false);
  });

  it('returns false for a malformed header', () => {
    expect(verifySignature('payload', 'secret', 'not-a-signature')).toBe(false);
    expect(verifySignature('payload', 'secret', '')).toBe(false);
    expect(verifySignature('payload', 'secret', null)).toBe(false);
    expect(verifySignature('payload', 'secret', undefined)).toBe(false);
  });

  it('returns false for wrong-length hex', () => {
    expect(verifySignature('payload', 'secret', 'sha256=abc')).toBe(false);
  });

  it('returns false for non-hex characters', () => {
    const hex = 'g' + '0'.repeat(63);
    expect(verifySignature('payload', 'secret', `sha256=${hex}`)).toBe(false);
  });

  it('is case-insensitive for hex', () => {
    const payload = 'test';
    const secret = 'secret';
    const sig = signPayload(payload, secret);
    // The function normalises to lowercase internally
    expect(verifySignature(payload, secret, sig.toUpperCase())).toBe(true);
  });
});

describe('parseTimestamp', () => {
  it('parses a valid unix timestamp string', () => {
    expect(parseTimestamp('1700000000')).toBe(1700000000000);
  });

  it('returns null for non-string input', () => {
    expect(parseTimestamp(null)).toBeNull();
    expect(parseTimestamp(undefined)).toBeNull();
  });

  it('returns null for empty string', () => {
    expect(parseTimestamp('')).toBeNull();
    expect(parseTimestamp('   ')).toBeNull();
  });

  it('returns null for non-numeric strings', () => {
    expect(parseTimestamp('abc')).toBeNull();
    expect(parseTimestamp('NaN')).toBeNull();
  });
});

describe('isWithinReplayWindow', () => {
  it('returns true for a recent timestamp', () => {
    const now = Date.now();
    expect(isWithinReplayWindow(now)).toBe(true);
  });

  it('returns true for a timestamp within tolerance', () => {
    const now = Date.now();
    expect(isWithinReplayWindow(now - 60_000)).toBe(true); // 1 minute ago
  });

  it('returns false for a timestamp outside tolerance', () => {
    const now = Date.now();
    expect(isWithinReplayWindow(now - 600_000)).toBe(false); // 10 minutes ago
  });

  it('returns true for a future timestamp within tolerance', () => {
    const now = Date.now();
    expect(isWithinReplayWindow(now + 60_000)).toBe(true); // 1 minute ahead
  });

  it('respects custom tolerance', () => {
    const now = Date.now();
    expect(isWithinReplayWindow(now - 30_000, 60)).toBe(true); // 30s within 60s window
    expect(isWithinReplayWindow(now - 90_000, 60)).toBe(false); // 90s outside 60s window
  });
});

describe('admitWebhookRequest', () => {
  const secret = 'test-webhook-secret';
  const makeValidRequest = (payload: string) => {
    const signature = signPayload(payload, secret);
    const timestamp = Math.floor(Date.now() / 1000).toString();
    return { signature, timestamp };
  };

  it('returns ok for a valid request', () => {
    const payload = '{"event":"test"}';
    const { signature, timestamp } = makeValidRequest(payload);

    const result = admitWebhookRequest(payload, secret, signature, timestamp);
    expect(result).toEqual({ ok: true, scheme: 'legacy' });
  });

  it('rejects missing signature', () => {
    const result = admitWebhookRequest('{}', secret, undefined, '123');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.status).toBe(401);
      expect(result.message).toContain('Missing signature');
    }
  });

  it('rejects missing timestamp', () => {
    const payload = '{}';
    const signature = signPayload(payload, secret);
    const result = admitWebhookRequest(payload, secret, signature, undefined);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.status).toBe(401);
      expect(result.message).toContain('Missing timestamp');
    }
  });

  it('rejects invalid timestamp format', () => {
    const payload = '{}';
    const signature = signPayload(payload, secret);
    const result = admitWebhookRequest(payload, secret, signature, 'not-a-number');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.status).toBe(400);
      expect(result.message).toContain('Invalid timestamp');
    }
  });

  it('rejects stale timestamp outside replay window', () => {
    const payload = '{}';
    const signature = signPayload(payload, secret);
    const staleTimestamp = Math.floor((Date.now() - 600_000) / 1000).toString(); // 10 min ago
    const result = admitWebhookRequest(payload, secret, signature, staleTimestamp);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.status).toBe(401);
      expect(result.message).toContain('outside allowed window');
    }
  });

  it('rejects invalid signature', () => {
    const payload = '{}';
    const timestamp = Math.floor(Date.now() / 1000).toString();
    const badSignature = 'sha256=' + '0'.repeat(64);
    const result = admitWebhookRequest(payload, secret, badSignature, timestamp);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.status).toBe(401);
      expect(result.message).toContain('Invalid signature');
    }
  });

  it('uses custom replay window', () => {
    const payload = '{}';
    const signature = signPayload(payload, secret);
    const timestamp = Math.floor((Date.now() - 30_000) / 1000).toString(); // 30s ago

    // Within 60s window
    expect(admitWebhookRequest(payload, secret, signature, timestamp, 60)).toEqual({
      ok: true,
      scheme: 'legacy',
    });

    // Outside 10s window
    const result = admitWebhookRequest(payload, secret, signature, timestamp, 10);
    expect(result.ok).toBe(false);
  });
});

describe('constants', () => {
  it('has expected header names', () => {
    expect(SIGNATURE_HEADER).toBe('X-SecureFlow-Signature');
    expect(TIMESTAMP_HEADER).toBe('X-SecureFlow-Timestamp');
  });

  it('has 5-minute default replay window', () => {
    expect(DEFAULT_REPLAY_WINDOW_SECONDS).toBe(300);
  });
});

describe('signPayloadV1', () => {
  it('produces a t=,v1= header', () => {
    const sig = signPayloadV1('hello', 'secret', 1_700_000_000);

    expect(sig).toMatch(/^t=1700000000,v1=[0-9a-f]{64}$/);
  });

  it('defaults the timestamp to now', () => {
    const before = Math.floor(Date.now() / 1000);
    const parsed = parseSignatureHeader(signPayloadV1('hello', 'secret'));
    const after = Math.floor(Date.now() / 1000);

    expect(parsed?.scheme).toBe('v1');
    if (parsed?.scheme === 'v1') {
      expect(parsed.timestampSeconds).toBeGreaterThanOrEqual(before);
      expect(parsed.timestampSeconds).toBeLessThanOrEqual(after);
    }
  });

  it('covers the timestamp, so the same body at two instants signs differently', () => {
    // This is the whole difference from the legacy scheme: change the
    // timestamp and the digest has to change with it, or the replay window is
    // policing a number nothing signed.
    const a = signPayloadV1('hello', 'secret', 1_700_000_000);
    const b = signPayloadV1('hello', 'secret', 1_700_000_001);

    expect(a).not.toBe(b);
  });

  it('produces a different digest for a different secret', () => {
    expect(signPayloadV1('hello', 'a', 1_700_000_000)).not.toBe(
      signPayloadV1('hello', 'b', 1_700_000_000)
    );
  });
});

describe('parseSignatureHeader', () => {
  it('parses the legacy scheme', () => {
    const hex = 'a'.repeat(64);

    expect(parseSignatureHeader(`sha256=${hex}`)).toEqual({ scheme: 'legacy', hex });
  });

  it('parses the v1 scheme', () => {
    const hex = 'b'.repeat(64);

    expect(parseSignatureHeader(`t=1700000000,v1=${hex}`)).toEqual({
      scheme: 'v1',
      hex,
      timestampSeconds: 1_700_000_000,
    });
  });

  it('is order-independent within a v1 header', () => {
    const hex = 'c'.repeat(64);

    expect(parseSignatureHeader(`v1=${hex},t=1700000000`)).toEqual({
      scheme: 'v1',
      hex,
      timestampSeconds: 1_700_000_000,
    });
  });

  it('tolerates whitespace between v1 fields', () => {
    const hex = 'd'.repeat(64);

    expect(parseSignatureHeader(`t=1700000000, v1=${hex}`)).toMatchObject({ scheme: 'v1', hex });
  });

  it('lets the first t= win, so an appended duplicate cannot displace it', () => {
    const hex = 'e'.repeat(64);

    expect(parseSignatureHeader(`t=1700000000,v1=${hex},t=1799999999`)).toMatchObject({
      timestampSeconds: 1_700_000_000,
    });
  });

  it('rejects a v1 header with no timestamp', () => {
    expect(parseSignatureHeader(`v1=${'a'.repeat(64)}`)).toBeNull();
  });

  it('rejects a v1 header with no digest', () => {
    expect(parseSignatureHeader('t=1700000000')).toBeNull();
  });

  it('rejects a non-decimal timestamp', () => {
    // `Number()` would take all three of these.
    expect(parseSignatureHeader(`t=0x10,v1=${'a'.repeat(64)}`)).toBeNull();
    expect(parseSignatureHeader(`t=1e9,v1=${'a'.repeat(64)}`)).toBeNull();
    expect(parseSignatureHeader(`t=17.5,v1=${'a'.repeat(64)}`)).toBeNull();
  });

  it('rejects a digest that is not exactly 64 hex characters', () => {
    expect(parseSignatureHeader(`t=1700000000,v1=${'a'.repeat(63)}`)).toBeNull();
    expect(parseSignatureHeader(`t=1700000000,v1=${'a'.repeat(65)}`)).toBeNull();
    expect(parseSignatureHeader('t=1700000000,v1=zz')).toBeNull();
    expect(parseSignatureHeader(`sha256=${'z'.repeat(64)}`)).toBeNull();
  });

  it('rejects empty, blank and non-string input', () => {
    expect(parseSignatureHeader('')).toBeNull();
    expect(parseSignatureHeader('   ')).toBeNull();
    expect(parseSignatureHeader(null)).toBeNull();
    expect(parseSignatureHeader(undefined)).toBeNull();
    expect(parseSignatureHeader(12345 as unknown as string)).toBeNull();
  });

  it('rejects an unknown scheme', () => {
    expect(parseSignatureHeader(`sha512=${'a'.repeat(64)}`)).toBeNull();
    expect(parseSignatureHeader(`t=1700000000,v2=${'a'.repeat(64)}`)).toBeNull();
  });
});

describe('verifySignature (v1)', () => {
  const secret = 'test-webhook-secret';
  const payload = '{"event":"alert"}';

  it('accepts a v1 signature', () => {
    expect(verifySignature(payload, secret, signPayloadV1(payload, secret, 1_700_000_000))).toBe(
      true
    );
  });

  it('rejects a v1 signature under the wrong secret', () => {
    expect(verifySignature(payload, 'other', signPayloadV1(payload, secret, 1_700_000_000))).toBe(
      false
    );
  });

  it('rejects a v1 signature whose t= was edited', () => {
    const sig = signPayloadV1(payload, secret, 1_700_000_000);
    const tampered = sig.replace('t=1700000000', 't=1700000900');

    expect(verifySignature(payload, secret, tampered)).toBe(false);
  });

  it('rejects a v1 signature over a different body', () => {
    const sig = signPayloadV1(payload, secret, 1_700_000_000);

    expect(verifySignature('{"event":"other"}', secret, sig)).toBe(false);
  });

  it('still accepts a legacy signature', () => {
    expect(verifySignature(payload, secret, signPayload(payload, secret))).toBe(true);
  });

  it('does not accept a legacy digest presented as v1, or the reverse', () => {
    // The material differs between schemes, so the digests are not
    // interchangeable even with the correct secret.
    const legacyHex = signPayload(payload, secret).slice('sha256='.length);
    expect(verifySignature(payload, secret, `t=1700000000,v1=${legacyHex}`)).toBe(false);

    const v1Hex = signPayloadV1(payload, secret, 1_700_000_000).split('v1=')[1];
    expect(verifySignature(payload, secret, `sha256=${v1Hex}`)).toBe(false);
  });
});

describe('admitWebhookRequest (v1)', () => {
  const secret = 'test-webhook-secret';
  const payload = '{"event":"alert"}';

  it('admits a v1 request and reports the scheme', () => {
    const ts = Math.floor(Date.now() / 1000);

    expect(admitWebhookRequest(payload, secret, signPayloadV1(payload, secret, ts), String(ts))).toEqual(
      { ok: true, scheme: 'v1' }
    );
  });

  it('rejects a v1 request whose header timestamp disagrees with the signed one', () => {
    // The manoeuvre v1 exists to stop: a captured request whose
    // `X-SecureFlow-Timestamp` is refreshed to slip back inside the window.
    // The signature is untouched and still verifies over its own `t=`, so
    // nothing but this cross-check catches it.
    const signedAt = Math.floor(Date.now() / 1000) - 3600;
    const sig = signPayloadV1(payload, secret, signedAt);
    const refreshedHeader = String(Math.floor(Date.now() / 1000));

    const result = admitWebhookRequest(payload, secret, sig, refreshedHeader);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.status).toBe(401);
      expect(result.message).toContain('does not match timestamp header');
    }
  });

  it('tolerates a one-second gap between the two timestamps', () => {
    const ts = Math.floor(Date.now() / 1000);

    expect(
      admitWebhookRequest(payload, secret, signPayloadV1(payload, secret, ts), String(ts - 1)).ok
    ).toBe(true);
  });

  it('rejects a stale v1 request', () => {
    const staleTs = Math.floor(Date.now() / 1000) - 600;
    const result = admitWebhookRequest(
      payload,
      secret,
      signPayloadV1(payload, secret, staleTs),
      String(staleTs)
    );

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toContain('outside allowed window');
  });

  it('rejects a v1 request signed with the wrong secret', () => {
    const ts = Math.floor(Date.now() / 1000);
    const result = admitWebhookRequest(
      payload,
      secret,
      signPayloadV1(payload, 'wrong-secret', ts),
      String(ts)
    );

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toContain('Invalid signature');
  });
});

describe('cross-module contract with the outbound dispatcher (#716)', () => {
  // The bug was that these two modules had drifted into two incompatible
  // formats on one header name, so SecureFlow rejected the webhooks SecureFlow
  // sent. These assertions are what stops that happening again: they fail if
  // either side changes the header names, the version tag, or the material the
  // digest is computed over.
  const secret = 'shared-webhook-secret';
  const payload = '{"event":"scan.completed","repo":"acme/api"}';

  it('agrees on the header names', () => {
    expect(SIGNATURE_HEADER).toBe(OUTBOUND_SIGNATURE_HEADER);
    expect(TIMESTAMP_HEADER).toBe(OUTBOUND_TIMESTAMP_HEADER);
  });

  it('agrees on the version tag', () => {
    expect(SIGNATURE_VERSION).toBe(OUTBOUND_SIGNATURE_VERSION);
  });

  it('produces byte-identical headers for the same input', () => {
    const ts = 1_700_000_000;

    expect(signPayloadV1(payload, secret, ts)).toBe(buildSignatureHeader(secret, payload, ts));
  });

  it('accepts what the outbound dispatcher sends', () => {
    const ts = Math.floor(Date.now() / 1000);
    const header = buildSignatureHeader(secret, payload, ts);

    expect(verifySignature(payload, secret, header)).toBe(true);
    expect(admitWebhookRequest(payload, secret, header, String(ts))).toEqual({
      ok: true,
      scheme: 'v1',
    });
  });

  it('rejects an outbound delivery whose body was altered in flight', () => {
    const ts = Math.floor(Date.now() / 1000);
    const header = buildSignatureHeader(secret, payload, ts);

    expect(verifySignature(payload.replace('acme', 'evil'), secret, header)).toBe(false);
  });
});
