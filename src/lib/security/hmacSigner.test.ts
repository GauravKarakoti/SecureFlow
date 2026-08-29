import { describe, it, expect } from 'vitest';
import {
  signPayload,
  verifySignature,
  parseTimestamp,
  isWithinReplayWindow,
  admitWebhookRequest,
  SIGNATURE_HEADER,
  TIMESTAMP_HEADER,
  DEFAULT_REPLAY_WINDOW_SECONDS,
} from './hmacSigner';

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
    expect(verifySignature('payload', 'secret', null as any)).toBe(false);
    expect(verifySignature('payload', 'secret', undefined as any)).toBe(false);
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
    expect(result).toEqual({ ok: true });
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
    expect(admitWebhookRequest(payload, secret, signature, timestamp, 60)).toEqual({ ok: true });

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
