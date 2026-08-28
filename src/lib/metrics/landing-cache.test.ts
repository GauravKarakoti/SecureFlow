import { describe, it, expect, vi } from 'vitest';
import { DEFAULT_METRICS_TTL_MS, createTtlCache } from './landing-cache';

/** A clock the test drives by hand, so nothing here waits on real time. */
function clock(start = 1_000) {
  let current = start;
  return {
    now: () => current,
    advance: (ms: number) => {
      current += ms;
    },
  };
}

describe('createTtlCache', () => {
  it('computes once and serves the same value inside the window', async () => {
    const load = vi.fn().mockResolvedValue('value');
    const cache = createTtlCache(load, { ttlMs: 1_000, now: clock().now });

    expect(await cache.get()).toBe('value');
    expect(await cache.get()).toBe('value');
    expect(load).toHaveBeenCalledTimes(1);
  });

  it('recomputes once the window has passed', async () => {
    const time = clock();
    const load = vi.fn().mockResolvedValueOnce('first').mockResolvedValueOnce('second');
    const cache = createTtlCache(load, { ttlMs: 1_000, now: time.now });

    expect(await cache.get()).toBe('first');

    time.advance(999);
    expect(await cache.get()).toBe('first');

    time.advance(2);
    expect(await cache.get()).toBe('second');
    expect(load).toHaveBeenCalledTimes(2);
  });

  it('collapses concurrent misses onto a single load', async () => {
    // The property that actually matters. A TTL cache without single-flight is
    // useless at exactly the moment it is needed: the instant the entry
    // expires under load, every concurrent caller misses together.
    let resolveLoad: (value: string) => void = () => {};
    const load = vi.fn(
      () =>
        new Promise<string>((resolve) => {
          resolveLoad = resolve;
        })
    );

    const cache = createTtlCache(load, { ttlMs: 1_000, now: clock().now });

    const all = Promise.all([cache.get(), cache.get(), cache.get()]);
    expect(cache.inFlight).toBe(true);

    resolveLoad('value');

    expect(await all).toEqual(['value', 'value', 'value']);
    expect(load).toHaveBeenCalledTimes(1);
    expect(cache.inFlight).toBe(false);
  });

  it('does not cache a rejection', async () => {
    // Latching a transient failure for the whole window would turn one bad
    // moment into a minute of bad responses.
    const load = vi
      .fn()
      .mockRejectedValueOnce(new Error('connection reset'))
      .mockResolvedValueOnce('recovered');

    const cache = createTtlCache(load, { ttlMs: 60_000, now: clock().now });

    await expect(cache.get()).rejects.toThrow('connection reset');
    expect(cache.inFlight).toBe(false);

    expect(await cache.get()).toBe('recovered');
    expect(load).toHaveBeenCalledTimes(2);
  });

  it('rejects every concurrent caller when the shared load fails', async () => {
    const load = vi.fn().mockRejectedValue(new Error('boom'));
    const cache = createTtlCache(load, { ttlMs: 1_000, now: clock().now });

    const results = await Promise.allSettled([cache.get(), cache.get()]);

    expect(results.every((result) => result.status === 'rejected')).toBe(true);
    expect(load).toHaveBeenCalledTimes(1);
  });

  it('peek reports what is cached without triggering a load', async () => {
    const time = clock();
    const load = vi.fn().mockResolvedValue('value');
    const cache = createTtlCache(load, { ttlMs: 1_000, now: time.now });

    expect(cache.peek()).toBeNull();
    expect(load).not.toHaveBeenCalled();

    await cache.get();
    expect(cache.peek()).toBe('value');

    time.advance(1_001);
    expect(cache.peek()).toBeNull();
    expect(load).toHaveBeenCalledTimes(1);
  });

  it('invalidate drops the entry so the next read recomputes', async () => {
    const load = vi.fn().mockResolvedValueOnce('first').mockResolvedValueOnce('second');
    const cache = createTtlCache(load, { ttlMs: 60_000, now: clock().now });

    expect(await cache.get()).toBe('first');
    cache.invalidate();
    expect(cache.peek()).toBeNull();
    expect(await cache.get()).toBe('second');
  });

  it('treats a zero or negative ttl as no caching at all', async () => {
    const load = vi.fn().mockResolvedValueOnce('first').mockResolvedValueOnce('second');
    const cache = createTtlCache(load, { ttlMs: -5, now: clock().now });

    expect(await cache.get()).toBe('first');
    expect(await cache.get()).toBe('second');
  });

  it('defaults to a one-minute window', () => {
    expect(DEFAULT_METRICS_TTL_MS).toBe(60_000);
  });
});
