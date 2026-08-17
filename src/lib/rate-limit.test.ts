import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { NextResponse } from 'next/server';

// Mock ioredis to prevent real network connection attempts during tests
vi.mock('ioredis', () => {
  const RedisMock = vi.fn(() => ({
    on: vi.fn(),
    get: vi.fn(),
    set: vi.fn(),
    incr: vi.fn(),
    expire: vi.fn(),
    quit: vi.fn()
  }));
  return { default: RedisMock, Redis: RedisMock };
});

// ---- getClientIp ----
//
// The exhaustive cases (spoofing, hop counting, the trusted-proxy allowlist,
// IPv6 and port normalization) live in ./client-ip.test.ts. What is kept here is
// the contract the rate-limit middleware below depends on.

import { UNKNOWN_CLIENT_IP, getClientIp } from './client-ip';

describe('getClientIp', () => {
  const h = (entries: Record<string, string>) =>
    ({ get: (k: string) => entries[k] ?? null }) as unknown as Headers;

  it('reads the trusted hop from x-forwarded-for, not the client-supplied left-most entry', () => {
    // Previously this returned "9.9.9.9" — whatever the caller typed — which is
    // what made every rate limit bypassable.
    expect(
      getClientIp(h({ 'x-real-ip': '1.2.3.4', 'x-forwarded-for': '9.9.9.9, 203.0.113.7' }), {
        trustedHopCount: 1,
        trustedProxies: [],
      })
    ).toBe('203.0.113.7');
  });

  it('ignores x-real-ip while a forwarded chain is present', () => {
    expect(
      getClientIp(h({ 'x-real-ip': '1.2.3.4', 'x-forwarded-for': '203.0.113.7' }), {
        trustedHopCount: 1,
        trustedProxies: [],
      })
    ).toBe('203.0.113.7');
  });

  it('uses x-real-ip when the trusted proxy set no forwarded chain', () => {
    expect(getClientIp(h({ 'x-real-ip': '5.6.7.8' }), { trustedHopCount: 1, trustedProxies: [] })).toBe(
      '5.6.7.8'
    );
  });

  it('returns a sentinel rather than 127.0.0.1 when no usable header is present', () => {
    // The old loopback fallback put every header-less caller in one shared
    // bucket, so a single noisy client rate-limited everybody else.
    expect(getClientIp(h({}), { trustedHopCount: 1, trustedProxies: [] })).toBe(UNKNOWN_CLIENT_IP);
  });

  it('trims whitespace from x-real-ip', () => {
    expect(getClientIp(h({ 'x-real-ip': '  3.3.3.3  ' }), { trustedHopCount: 1, trustedProxies: [] })).toBe(
      '3.3.3.3'
    );
  });
});

// ---- checkRateLimit (in-memory fallback) ----

// Isolate the module so each describe block gets a fresh memoryStore.
describe('checkRateLimit — in-memory fallback (no Redis)', () => {
  beforeEach(() => {
    vi.resetModules();
    // Ensure REDIS_URL is unset so the module uses the in-memory path.
    delete process.env.REDIS_URL;
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('allows requests under the limit', async () => {
    const { checkRateLimit } = await import('./redis');
    expect(await checkRateLimit('key-a', 3, 60)).toBe(true);
    expect(await checkRateLimit('key-a', 3, 60)).toBe(true);
    expect(await checkRateLimit('key-a', 3, 60)).toBe(true);
  });

  it('blocks the request that exceeds the limit', async () => {
    const { checkRateLimit } = await import('./redis');
    await checkRateLimit('key-b', 2, 60);
    await checkRateLimit('key-b', 2, 60);
    expect(await checkRateLimit('key-b', 2, 60)).toBe(false);
  });

  it('resets the counter after the window expires', async () => {
    vi.useFakeTimers();
    const { checkRateLimit } = await import('./redis');

    await checkRateLimit('key-c', 1, 1);
    expect(await checkRateLimit('key-c', 1, 1)).toBe(false);

    vi.advanceTimersByTime(1001);
    expect(await checkRateLimit('key-c', 1, 1)).toBe(true);
    vi.useRealTimers();
  });
});

// ---- withRateLimit middleware ----

describe('withRateLimit middleware', () => {
  let redisModule: typeof import('./redis');
  let rateLimitModule: typeof import('./middleware/rate-limit');

  beforeEach(async () => {
    vi.resetModules();
    delete process.env.REDIS_URL;
    redisModule = await import('./redis');
    rateLimitModule = await import('./middleware/rate-limit');
  });

  function makeReq(ip = '1.1.1.1') {
    return {
      headers: { get: (k: string) => (k === 'x-real-ip' ? ip : null) },
    } as any;
  }

  it('calls the inner handler when under the limit', async () => {
    const handler = vi.fn().mockResolvedValue({ status: 200 });
    const wrapped = rateLimitModule.withRateLimit(handler, { limit: 10, windowSeconds: 60, keyPrefix: 'test' });

    const res = await wrapped(makeReq('2.2.2.2'));
    expect(handler).toHaveBeenCalledOnce();
    expect(res.status).toBe(200);
  });

  it('returns 429 when the limit is exceeded', async () => {
    const handler = vi.fn().mockResolvedValue({ status: 200 });
    const wrapped = rateLimitModule.withRateLimit(handler, { limit: 1, windowSeconds: 60, keyPrefix: 'test-limit' });

    await wrapped(makeReq('3.3.3.3'));           // first — allowed
    const res = await wrapped(makeReq('3.3.3.3')); // second — blocked

    expect(res.status).toBe(429);
    expect(handler).toHaveBeenCalledOnce();
  });

  it('includes Retry-After header in the 429 response', async () => {
    const handler = vi.fn().mockResolvedValue({ status: 200 });
    const wrapped = rateLimitModule.withRateLimit(handler, { limit: 1, windowSeconds: 30, keyPrefix: 'test-retry' });

    await wrapped(makeReq('4.4.4.4'));
    const res = await wrapped(makeReq('4.4.4.4'));

    // The window has only just opened, so the full 30s is still outstanding.
    expect(res.headers.get('Retry-After')).toBe('30');
  });

  it('reports the time actually left in the window, not the whole window', async () => {
    vi.useFakeTimers();
    const handler = vi.fn().mockResolvedValue({ status: 200 });
    const wrapped = rateLimitModule.withRateLimit(handler, { limit: 1, windowSeconds: 60, keyPrefix: 'test-partial' });

    await wrapped(makeReq('4.5.4.5'));
    vi.advanceTimersByTime(50_000); // 50s into the 60s window
    const res = await wrapped(makeReq('4.5.4.5'));

    expect(res.status).toBe(429);
    expect(res.headers.get('Retry-After')).toBe('10');
    vi.useRealTimers();
  });

  it('sets X-RateLimit-* headers on the 429 response', async () => {
    const handler = vi.fn().mockResolvedValue({ status: 200 });
    const wrapped = rateLimitModule.withRateLimit(handler, { limit: 2, windowSeconds: 60, keyPrefix: 'test-429-headers' });

    await wrapped(makeReq('4.6.4.6'));
    await wrapped(makeReq('4.6.4.6'));
    const res = await wrapped(makeReq('4.6.4.6'));

    expect(res.status).toBe(429);
    expect(res.headers.get('X-RateLimit-Limit')).toBe('2');
    expect(res.headers.get('X-RateLimit-Remaining')).toBe('0');
    expect(Number(res.headers.get('X-RateLimit-Reset'))).toBeGreaterThan(0);
  });

  it('sets X-RateLimit-* headers on a successful response', async () => {
    const handler = vi.fn().mockResolvedValue(NextResponse.json({ ok: true }));
    const wrapped = rateLimitModule.withRateLimit(handler, { limit: 5, windowSeconds: 60, keyPrefix: 'test-ok-headers' });

    const res = await wrapped(makeReq('4.7.4.7'));

    expect(res.status).toBe(200);
    expect(res.headers.get('X-RateLimit-Limit')).toBe('5');
    expect(res.headers.get('X-RateLimit-Remaining')).toBe('4');
  });

  it('counts down remaining across successive requests', async () => {
    const wrapped = rateLimitModule.withRateLimit(
      vi.fn().mockImplementation(async () => NextResponse.json({ ok: true })),
      { limit: 3, windowSeconds: 60, keyPrefix: 'test-countdown' }
    );

    const first = await wrapped(makeReq('4.8.4.8'));
    const second = await wrapped(makeReq('4.8.4.8'));

    expect(first.headers.get('X-RateLimit-Remaining')).toBe('2');
    expect(second.headers.get('X-RateLimit-Remaining')).toBe('1');
  });

  it('does not advertise headers when the decision came from the fallback', async () => {
    const spy = vi.spyOn(redisModule, 'checkRateLimitDetailed').mockResolvedValueOnce({
      allowed: true,
      limit: 5,
      remaining: 5,
      resetAt: Date.now() + 60_000,
      degraded: true,
    });

    const handler = vi.fn().mockResolvedValue(NextResponse.json({ ok: true }));
    const wrapped = rateLimitModule.withRateLimit(handler, { limit: 5, windowSeconds: 60, keyPrefix: 'test-degraded' });

    const res = await wrapped(makeReq('4.9.4.9'));

    expect(res.headers.get('X-RateLimit-Limit')).toBeNull();
    spy.mockRestore();
  });

  it('tolerates a handler result that is not a Response', async () => {
    // Several existing tests pass plain objects through; the middleware must not
    // assume `headers.set` exists.
    const handler = vi.fn().mockResolvedValue({ status: 200 });
    const wrapped = rateLimitModule.withRateLimit(handler, { limit: 5, windowSeconds: 60, keyPrefix: 'test-plain' });

    await expect(wrapped(makeReq('4.10.4.10'))).resolves.toEqual({ status: 200 });
  });
});

// ---- secondsUntilReset & buildRateLimitHeaders ----

describe('secondsUntilReset', () => {
  it('rounds up partial seconds', async () => {
    const { secondsUntilReset } = await import('./middleware/rate-limit');
    expect(secondsUntilReset(10_500, 10_000)).toBe(1);
    expect(secondsUntilReset(11_200, 10_000)).toBe(2);
  });

  it('never returns less than one second', async () => {
    const { secondsUntilReset } = await import('./middleware/rate-limit');
    expect(secondsUntilReset(9_000, 10_000)).toBe(1);
    expect(secondsUntilReset(10_000, 10_000)).toBe(1);
  });
});

describe('buildRateLimitHeaders', () => {
  it('expresses the reset time in epoch seconds', async () => {
    const { buildRateLimitHeaders } = await import('./middleware/rate-limit');
    const headers = buildRateLimitHeaders({
      allowed: true,
      limit: 20,
      remaining: 7,
      resetAt: 1_700_000_000_000,
      degraded: false,
    });

    expect(headers).toEqual({
      'X-RateLimit-Limit': '20',
      'X-RateLimit-Remaining': '7',
      'X-RateLimit-Reset': '1700000000',
    });
  });
});

// ---- in-memory fallback bounding ----

describe('in-memory fallback — bounding and eviction', () => {
  beforeEach(() => {
    vi.resetModules();
    delete process.env.REDIS_URL;
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('reclaims expired entries instead of retaining them forever', async () => {
    vi.useFakeTimers();
    const { checkRateLimit, getMemoryStoreSize } = await import('./redis');

    for (let i = 0; i < 50; i++) {
      await checkRateLimit(`sweep:${i}`, 5, 1);
    }
    expect(getMemoryStoreSize()).toBe(50);

    // Move past the window and past the sweep interval, then touch one key to
    // trigger the amortised cleanup.
    vi.advanceTimersByTime(31_000);
    await checkRateLimit('sweep:trigger', 5, 1);

    // The 50 expired entries are gone; only the key just written remains.
    expect(getMemoryStoreSize()).toBe(1);
  });

  it('does not sweep entries whose window is still open', async () => {
    vi.useFakeTimers();
    const { checkRateLimit, getMemoryStoreSize } = await import('./redis');

    await checkRateLimit('live:a', 5, 600);
    vi.advanceTimersByTime(31_000);
    await checkRateLimit('live:b', 5, 600);

    expect(getMemoryStoreSize()).toBe(2);
  });

  it('stays bounded under a flood of distinct keys', async () => {
    const { checkRateLimit, getMemoryStoreSize, resetMemoryStore } = await import('./redis');
    resetMemoryStore();

    // Simulates a spray of requests with varying X-Forwarded-For values, which
    // previously grew the map without limit.
    for (let i = 0; i < 10_200; i++) {
      await checkRateLimit(`flood:${i}`, 5, 600);
    }

    expect(getMemoryStoreSize()).toBeLessThanOrEqual(10_000);
  });

  it('still enforces the limit for keys it is tracking', async () => {
    const { checkRateLimit, resetMemoryStore } = await import('./redis');
    resetMemoryStore();

    expect(await checkRateLimit('bounded:key', 2, 60)).toBe(true);
    expect(await checkRateLimit('bounded:key', 2, 60)).toBe(true);
    expect(await checkRateLimit('bounded:key', 2, 60)).toBe(false);
  });
});

// ---- checkRateLimitDetailed ----

describe('checkRateLimitDetailed', () => {
  beforeEach(() => {
    vi.resetModules();
    delete process.env.REDIS_URL;
  });

  it('reports the remaining budget as it is consumed', async () => {
    const { checkRateLimitDetailed, resetMemoryStore } = await import('./redis');
    resetMemoryStore();

    expect(await checkRateLimitDetailed('detail:a', 3, 60)).toMatchObject({
      allowed: true,
      limit: 3,
      remaining: 2,
      degraded: false,
    });
    expect(await checkRateLimitDetailed('detail:a', 3, 60)).toMatchObject({ remaining: 1 });
    expect(await checkRateLimitDetailed('detail:a', 3, 60)).toMatchObject({ remaining: 0, allowed: true });
    expect(await checkRateLimitDetailed('detail:a', 3, 60)).toMatchObject({ remaining: 0, allowed: false });
  });

  it('keeps resetAt stable across the window', async () => {
    vi.useFakeTimers();
    const { checkRateLimitDetailed, resetMemoryStore } = await import('./redis');
    resetMemoryStore();

    const first = await checkRateLimitDetailed('detail:reset', 5, 60);
    vi.advanceTimersByTime(5_000);
    const second = await checkRateLimitDetailed('detail:reset', 5, 60);

    expect(second.resetAt).toBe(first.resetAt);
    vi.useRealTimers();
  });

  it('never reports a negative remaining', async () => {
    const { checkRateLimitDetailed, resetMemoryStore } = await import('./redis');
    resetMemoryStore();

    await checkRateLimitDetailed('detail:neg', 1, 60);
    for (let i = 0; i < 5; i++) {
      const result = await checkRateLimitDetailed('detail:neg', 1, 60);
      expect(result.remaining).toBe(0);
    }
  });
});

// ---- Redis error & timeout fallback strategies ----

describe('checkRateLimit & withRateLimit — Redis fallback strategies', () => {
  let redisModule: typeof import('./redis');
  let rateLimitModule: typeof import('./middleware/rate-limit');

  beforeEach(async () => {
    vi.resetModules();
    delete process.env.REDIS_URL;
    redisModule = await import('./redis');
    rateLimitModule = await import('./middleware/rate-limit');
  });

  it('fails open (returns true) when fallbackStrategy is fail-open and the check throws', async () => {
    const spy = vi.spyOn(redisModule, 'checkRateLimitDetailed').mockRejectedValueOnce(new Error('Redis unreachable'));

    const handler = vi.fn().mockResolvedValue({ status: 200 });
    const wrapped = rateLimitModule.withRateLimit(handler, {
      limit: 5,
      windowSeconds: 60,
      keyPrefix: 'fail-open-test',
      fallbackStrategy: 'fail-open',
    });

    const req = { headers: { get: () => '1.1.1.1' } } as any;
    const res = await wrapped(req);

    expect(handler).toHaveBeenCalledOnce();
    expect(res.status).toBe(200);
    spy.mockRestore();
  });

  it('fails closed (returns 429) when fallbackStrategy is fail-closed and the check throws', async () => {
    const spy = vi.spyOn(redisModule, 'checkRateLimitDetailed').mockRejectedValueOnce(new Error('Redis unreachable'));

    const handler = vi.fn().mockResolvedValue({ status: 200 });
    const wrapped = rateLimitModule.withRateLimit(handler, {
      limit: 5,
      windowSeconds: 60,
      keyPrefix: 'fail-closed-test',
      fallbackStrategy: 'fail-closed',
    });

    const req = { headers: { get: () => '1.1.1.1' } } as any;
    const res = await wrapped(req);

    expect(res.status).toBe(429);
    expect(handler).not.toHaveBeenCalled();
    spy.mockRestore();
  });
});