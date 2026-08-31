import { describe, it, expect, beforeEach } from 'vitest';
import {
  USER_FILTER_CACHE_MAX_ENTRIES,
  USER_FILTER_CACHE_TTL_MS,
  __setUserFilterClockForTests,
  cachedUserCount,
  invalidateCachedUserFilters,
  readCachedUserFilters,
  valuesFromGroups,
  writeCachedUserFilters,
} from './user-filter-cache';

let now = 0;

beforeEach(() => {
  now = 1_000_000;
  __setUserFilterClockForTests(() => now);
});

const FILTERS = { actions: ['SCAN', 'TRIAGE'], decisions: ['PASS'] };

describe('readCachedUserFilters / writeCachedUserFilters (#659)', () => {
  it('returns null when cold', () => {
    expect(readCachedUserFilters('user-1')).toBeNull();
  });

  it('serves what was written', () => {
    writeCachedUserFilters('user-1', FILTERS);

    expect(readCachedUserFilters('user-1')).toEqual(FILTERS);
  });

  it('keeps each user separate', () => {
    writeCachedUserFilters('user-1', FILTERS);
    writeCachedUserFilters('user-2', { actions: ['OTHER'], decisions: [] });

    expect(readCachedUserFilters('user-1')?.actions).toEqual(['SCAN', 'TRIAGE']);
    expect(readCachedUserFilters('user-2')?.actions).toEqual(['OTHER']);
  });

  it('expires after the TTL', () => {
    writeCachedUserFilters('user-1', FILTERS);

    now += USER_FILTER_CACHE_TTL_MS - 1;
    expect(readCachedUserFilters('user-1')).not.toBeNull();

    now += 1;
    expect(readCachedUserFilters('user-1')).toBeNull();
  });

  it('hands back copies, so a caller cannot mutate the cache', () => {
    writeCachedUserFilters('user-1', FILTERS);

    const first = readCachedUserFilters('user-1')!;
    first.actions.push('INJECTED');
    first.decisions.length = 0;

    expect(readCachedUserFilters('user-1')).toEqual(FILTERS);
  });

  it('copies on write too, so mutating the source afterwards does not leak in', () => {
    const source = { actions: ['SCAN'], decisions: ['PASS'] };
    writeCachedUserFilters('user-1', source);

    source.actions.push('LATER');

    expect(readCachedUserFilters('user-1')?.actions).toEqual(['SCAN']);
  });

  it('overwrites an existing entry rather than accumulating', () => {
    writeCachedUserFilters('user-1', FILTERS);
    writeCachedUserFilters('user-1', { actions: ['NEW'], decisions: [] });

    expect(readCachedUserFilters('user-1')?.actions).toEqual(['NEW']);
    expect(cachedUserCount()).toBe(1);
  });
});

describe('invalidateCachedUserFilters (#659)', () => {
  it('drops just that user', () => {
    writeCachedUserFilters('user-1', FILTERS);
    writeCachedUserFilters('user-2', FILTERS);

    invalidateCachedUserFilters('user-1');

    expect(readCachedUserFilters('user-1')).toBeNull();
    expect(readCachedUserFilters('user-2')).not.toBeNull();
  });

  it('is a no-op for a user with no entry', () => {
    expect(() => invalidateCachedUserFilters('nobody')).not.toThrow();
  });
});

describe('cache bounds (#659)', () => {
  it('stays under the entry cap, unlike an unbounded map keyed by user id', () => {
    for (let i = 0; i < USER_FILTER_CACHE_MAX_ENTRIES + 50; i++) {
      writeCachedUserFilters(`user-${i}`, FILTERS);
    }

    expect(cachedUserCount()).toBeLessThanOrEqual(USER_FILTER_CACHE_MAX_ENTRIES);
  });

  it('evicts the least recently used entry, not the most recent write', () => {
    writeCachedUserFilters('oldest', FILTERS);
    for (let i = 0; i < USER_FILTER_CACHE_MAX_ENTRIES - 1; i++) {
      writeCachedUserFilters(`filler-${i}`, FILTERS);
    }

    // Touching `oldest` moves it to the recent end.
    expect(readCachedUserFilters('oldest')).not.toBeNull();

    writeCachedUserFilters('newcomer', FILTERS);

    expect(readCachedUserFilters('oldest')).not.toBeNull();
    expect(readCachedUserFilters('newcomer')).not.toBeNull();
  });

  it('reclaims expired entries before evicting live ones', () => {
    for (let i = 0; i < USER_FILTER_CACHE_MAX_ENTRIES; i++) {
      writeCachedUserFilters(`stale-${i}`, FILTERS);
    }

    now += USER_FILTER_CACHE_TTL_MS + 1;
    writeCachedUserFilters('fresh', FILTERS);

    expect(cachedUserCount()).toBe(1);
    expect(readCachedUserFilters('fresh')).not.toBeNull();
  });
});

describe('valuesFromGroups (#659)', () => {
  it('extracts the named column', () => {
    expect(
      valuesFromGroups([{ action: 'SCAN' }, { action: 'TRIAGE' }], 'action')
    ).toEqual(['SCAN', 'TRIAGE']);
  });

  it('drops nulls, since decision is nullable', () => {
    expect(
      valuesFromGroups([{ decision: 'PASS' }, { decision: null }, { decision: 'BLOCK' }], 'decision')
    ).toEqual(['BLOCK', 'PASS']);
  });

  it('drops empty strings, which would be an unselectable filter option', () => {
    expect(valuesFromGroups([{ action: '' }, { action: 'SCAN' }], 'action')).toEqual(['SCAN']);
  });

  it('dedupes and sorts, so dropdown order does not depend on the database', () => {
    expect(
      valuesFromGroups([{ action: 'ZETA' }, { action: 'ALPHA' }, { action: 'ZETA' }], 'action')
    ).toEqual(['ALPHA', 'ZETA']);
  });

  it('ignores a non-string value', () => {
    expect(valuesFromGroups([{ action: 42 }, { action: 'SCAN' }], 'action')).toEqual(['SCAN']);
  });

  it('returns nothing for an empty result', () => {
    expect(valuesFromGroups([], 'action')).toEqual([]);
  });

  it('returns nothing when the column is absent from every group', () => {
    expect(valuesFromGroups([{ other: 'x' }], 'action')).toEqual([]);
  });
});
