import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  FILTER_CACHE_TTL_MS,
  __setClockForTests,
  invalidateCachedActions,
  readCachedActions,
  writeCachedActions,
} from './audit-filter-cache';

let now = 1_000;

beforeEach(() => {
  now = 1_000;
  __setClockForTests(() => now);
});

afterEach(() => {
  __setClockForTests();
});

describe('audit filter cache', () => {
  it('is cold to begin with', () => {
    expect(readCachedActions()).toBeNull();
  });

  it('returns what was written', () => {
    writeCachedActions(['A', 'B']);
    expect(readCachedActions()).toEqual(['A', 'B']);
  });

  it('expires once the TTL has passed', () => {
    writeCachedActions(['A']);

    now += FILTER_CACHE_TTL_MS - 1;
    expect(readCachedActions()).toEqual(['A']);

    now += 1;
    expect(readCachedActions()).toBeNull();
  });

  it('hands back a copy, so a caller cannot mutate the cache', () => {
    // The action list goes straight into a dropdown; a component sorting it in
    // place must not corrupt what the next reader sees.
    writeCachedActions(['A', 'B']);

    const first = readCachedActions();
    first?.push('C');

    expect(readCachedActions()).toEqual(['A', 'B']);
  });

  it('copies on write too', () => {
    const source = ['A'];
    writeCachedActions(source);
    source.push('B');

    expect(readCachedActions()).toEqual(['A']);
  });

  it('can be invalidated explicitly', () => {
    // The admin write paths call this: either can append an AuditLog row with
    // an action name the dropdown has not seen.
    writeCachedActions(['A']);
    invalidateCachedActions();

    expect(readCachedActions()).toBeNull();
  });

  it('refreshes the TTL on rewrite', () => {
    writeCachedActions(['A']);
    now += FILTER_CACHE_TTL_MS - 1;
    writeCachedActions(['A', 'B']);
    now += FILTER_CACHE_TTL_MS - 1;

    expect(readCachedActions()).toEqual(['A', 'B']);
  });

  it('caches an empty list rather than treating it as cold', () => {
    // A fresh deployment genuinely has no audit actions yet, and re-querying on
    // every render to rediscover that would be the same waste at a smaller
    // scale.
    writeCachedActions([]);
    expect(readCachedActions()).toEqual([]);
  });
});
