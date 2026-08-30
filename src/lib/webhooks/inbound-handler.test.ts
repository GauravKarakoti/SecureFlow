import { describe, it, expect, vi } from 'vitest';

import {
  describePayload,
  resolveEventType,
  safeEventLabel,
  processPayload,
} from './inbound-handler';

function headers(init: Record<string, string> = {}): Headers {
  return new Headers(init);
}

/** A logger stub shaped like the one `createLogger` returns. */
function fakeLogger() {
  const records: Array<{ level: string; message: string; meta?: unknown }> = [];
  const push = (level: string) => (message: string, meta?: unknown) =>
    void records.push({ level, message, meta });

  return {
    records,
    logger: {
      debug: vi.fn(push('debug')),
      info: vi.fn(push('info')),
      warn: vi.fn(push('warn')),
      error: vi.fn(push('error')),
      child: vi.fn(),
    } as never,
  };
}

describe('resolveEventType', () => {
  it('prefers x-webhook-event', () => {
    expect(
      resolveEventType(headers({ 'x-webhook-event': 'alert', 'x-event-type': 'ping' }), {
        event: 'notification',
      })
    ).toBe('alert');
  });

  it('falls back to x-event-type', () => {
    expect(resolveEventType(headers({ 'x-event-type': 'ping' }), { event: 'alert' })).toBe('ping');
  });

  it('falls back to the body', () => {
    expect(resolveEventType(headers(), { event: 'notification' })).toBe('notification');
  });

  it('trims surrounding whitespace', () => {
    expect(resolveEventType(headers({ 'x-webhook-event': '  alert  ' }), {})).toBe('alert');
  });

  it('skips a blank header rather than treating it as an event', () => {
    expect(resolveEventType(headers({ 'x-webhook-event': '   ' }), { event: 'ping' })).toBe('ping');
  });

  it('returns null when nothing declares an event', () => {
    expect(resolveEventType(headers(), {})).toBeNull();
    expect(resolveEventType(headers(), { event: 42 })).toBeNull();
  });
});

describe('safeEventLabel', () => {
  it('passes the known events through', () => {
    expect(safeEventLabel('ping')).toBe('ping');
    expect(safeEventLabel('alert')).toBe('alert');
    expect(safeEventLabel('notification')).toBe('notification');
  });

  it('reports null as unknown', () => {
    expect(safeEventLabel(null)).toBe('unknown');
  });

  it('does not reflect an unrecognised event back', () => {
    // The sender controls this string and it reaches both a log line and the
    // response body, so it is reported rather than echoed.
    expect(safeEventLabel('deploy')).toBe('unknown');
    expect(safeEventLabel('alert\nFAKE: injected log line')).toBe('unknown');
    expect(safeEventLabel('<script>alert(1)</script>')).toBe('unknown');
  });

  it('rejects an over-long event name', () => {
    expect(safeEventLabel('a'.repeat(65))).toBe('unknown');
  });
});

describe('describePayload', () => {
  it('reports the keys, never the values', () => {
    const result = describePayload({ token: 'ghp_realsecret', email: 'a@b.test' });

    expect(result.keys).toEqual(['token', 'email']);
    expect(JSON.stringify(result)).not.toContain('ghp_realsecret');
    expect(JSON.stringify(result)).not.toContain('a@b.test');
  });

  it('counts every key even when it lists only some', () => {
    const payload = Object.fromEntries(
      Array.from({ length: 100 }, (_, i) => [`k${i}`, i])
    );
    const result = describePayload(payload);

    expect(result.keyCount).toBe(100);
    expect(result.keys).toHaveLength(25);
    expect(result.truncatedKeys).toBe(true);
  });

  it('does not flag a small payload as truncated', () => {
    expect(describePayload({ a: 1 }).truncatedKeys).toBe(false);
  });

  it('handles an empty payload', () => {
    expect(describePayload({})).toEqual({ keys: [], keyCount: 0, truncatedKeys: false });
  });
});

describe('processPayload', () => {
  it('answers ping with pong and logs nothing', () => {
    const { logger, records } = fakeLogger();

    expect(processPayload({}, 'ping', logger)).toEqual({
      status: 'pong',
      message: 'Webhook verified',
    });
    expect(records).toHaveLength(0);
  });

  it('acknowledges an alert', () => {
    const { logger, records } = fakeLogger();

    expect(processPayload({ severity: 'high' }, 'alert', logger)).toEqual({
      status: 'received',
      message: 'Alert processed',
    });
    expect(records[0].message).toBe('Alert received');
  });

  it('acknowledges a notification', () => {
    const { logger } = fakeLogger();

    expect(processPayload({}, 'notification', logger)).toEqual({
      status: 'received',
      message: 'Notification processed',
    });
  });

  it('acknowledges an unknown event without echoing its name', () => {
    const { logger, records } = fakeLogger();

    expect(processPayload({}, 'deploy', logger)).toEqual({
      status: 'received',
      message: 'Webhook acknowledged',
    });
    expect((records[0].meta as { event: string }).event).toBe('unknown');
  });

  it('never puts a payload value in a log record (#720)', () => {
    // The bug: `console.log('[WEBHOOK] Alert received:', payload)` wrote the
    // whole third-party body to stdout, past the level gate and past the
    // redaction in @/lib/logger.
    const { logger, records } = fakeLogger();

    processPayload(
      { apiKey: 'sk-live-1234567890', customerEmail: 'person@example.test' },
      'alert',
      logger
    );

    const serialized = JSON.stringify(records);
    expect(serialized).not.toContain('sk-live-1234567890');
    expect(serialized).not.toContain('person@example.test');
    expect(serialized).toContain('apiKey');
  });
});
