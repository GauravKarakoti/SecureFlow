import { describe, it, expect, vi, beforeEach } from 'vitest';

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

import { getClientIp } from './client-ip';

describe('getClientIp', () => {
  const h = (entries: Record<string, string>) =>
    ({ get: (k: string) => entries[k] ?? null }) as unknown as Headers;

  it('prefers x-real-ip over x-forwarded-for', () => {
    expect(getClientIp(h({ 'x-real-ip': '1.2.3.4', 'x-forwarded-for': '9.9.9.9' }))).toBe('1.2.3.4');
  });

  it('returns the first entry of x-forwarded-for when x-real-ip is absent', () => {
    expect(getClientIp(h({ 'x-forwarded-for': '5.6.7.8, 10.0.0.1' }))).toBe('5.6.7.8');
  });

  it('falls back to 127.0.0.1 when no IP headers are present', () => {
    expect(getClientIp(h({}))).toBe('127.0.0.1');
  });

  it('trims whitespace from x-real-ip', () => {
    expect(getClientIp(h({ 'x-real-ip': '  3.3.3.3  ' }))).toBe('3.3.3.3');
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
  beforeEach(() => {
    vi.resetModules();
    delete process.env.REDIS_URL;
  });

  function makeReq(ip = '1.1.1.1') {
    return {
      headers: { get: (k: string) => (k === 'x-real-ip' ? ip : null) },
    } as any;
  }

  it('calls the inner handler when under the limit', async () => {
    const { withRateLimit } = await import('./middleware/rateLimit');
    const handler = vi.fn(async () => ({ status: 200 } as any));
    const wrapped = withRateLimit(handler, { limit: 10, windowSeconds: 60, keyPrefix: 'test' });

    const res = await wrapped(makeReq('2.2.2.2'));
    expect(handler).toHaveBeenCalledOnce();
    expect(res.status).toBe(200);
  });

  it('returns 429 when the limit is exceeded', async () => {
    const { withRateLimit } = await import('./middleware/rateLimit');
    const handler = vi.fn(async () => ({ status: 200 } as any));
    const wrapped = withRateLimit(handler, { limit: 1, windowSeconds: 60, keyPrefix: 'test-limit' });

    await wrapped(makeReq('3.3.3.3'));           // first — allowed
    const res = await wrapped(makeReq('3.3.3.3')); // second — blocked

    expect(res.status).toBe(429);
    expect(handler).toHaveBeenCalledOnce();
  });

  it('includes Retry-After header in the 429 response', async () => {
    const { withRateLimit } = await import('./middleware/rateLimit');
    const handler = vi.fn(async () => ({ status: 200 } as any));
    const wrapped = withRateLimit(handler, { limit: 1, windowSeconds: 30, keyPrefix: 'test-retry' });

    await wrapped(makeReq('4.4.4.4'));
    const res = await wrapped(makeReq('4.4.4.4'));

    expect(res.headers.get('Retry-After')).toBe('30');
  });
});

// ---- Redis error & timeout fallback strategies ----

describe('checkRateLimit & withRateLimit — Redis fallback strategies', () => {
  let redisModule: typeof import('./redis');
  let rateLimitModule: typeof import('./middleware/rateLimit');

  beforeEach(async () => {
    vi.resetModules();
    delete process.env.REDIS_URL;
    redisModule = await import('./redis');
    rateLimitModule = await import('./middleware/rateLimit');
  });

  it('fails open (returns true) when fallbackStrategy is fail-open and checkRateLimit throws', async () => {
    const spy = vi.spyOn(redisModule, 'checkRateLimit').mockRejectedValueOnce(new Error('Redis unreachable'));

    const handler = vi.fn(async () => ({ status: 200 } as any));
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

  it('fails closed (returns 429) when fallbackStrategy is fail-closed and checkRateLimit throws', async () => {
    const spy = vi.spyOn(redisModule, 'checkRateLimit').mockRejectedValueOnce(new Error('Redis unreachable'));

    const handler = vi.fn(async () => ({ status: 200 } as any));
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
