import { describe, it, expect } from 'vitest';
import {
  DEFAULT_PAGE_SIZE,
  MAX_PAGE_SIZE,
  USERS_FETCH_ALL_LIMIT,
  actionsFromGroups,
  buildAuditLogWhere,
  buildUserWhere,
  collectActorIds,
  resolvePagination,
  totalPagesFor,
} from './queries';

describe('resolvePagination', () => {
  it('applies the defaults', () => {
    expect(resolvePagination()).toEqual({
      page: 1,
      pageSize: DEFAULT_PAGE_SIZE,
      skip: 0,
      take: DEFAULT_PAGE_SIZE,
    });
  });

  it('computes skip from the page and size', () => {
    expect(resolvePagination({ page: 3, pageSize: 25 })).toMatchObject({ skip: 50, take: 25 });
  });

  it('clamps a page below 1 rather than erroring', () => {
    // An admin who types ?page=0 should get the first page.
    expect(resolvePagination({ page: 0 }).page).toBe(1);
    expect(resolvePagination({ page: -5 }).page).toBe(1);
  });

  it('clamps the page size to the ceiling', () => {
    expect(resolvePagination({ pageSize: 10_000 }).pageSize).toBe(MAX_PAGE_SIZE);
    expect(resolvePagination({ pageSize: 0 }).pageSize).toBe(1);
    expect(resolvePagination({ pageSize: -3 }).pageSize).toBe(1);
  });

  it('honours a caller-supplied ceiling', () => {
    expect(resolvePagination({ pageSize: 500 }, 50).pageSize).toBe(50);
  });

  it('survives non-integer input', () => {
    expect(resolvePagination({ page: 2.7, pageSize: 10.9 })).toMatchObject({
      page: 2,
      pageSize: 10,
    });
  });

  it('falls back rather than producing NaN', () => {
    expect(resolvePagination({ page: Number.NaN, pageSize: Number.NaN })).toEqual({
      page: 1,
      pageSize: DEFAULT_PAGE_SIZE,
      skip: 0,
      take: DEFAULT_PAGE_SIZE,
    });
  });
});

describe('totalPagesFor', () => {
  it('rounds up', () => {
    expect(totalPagesFor(51, 25)).toBe(3);
  });

  it('never returns zero, so the UI always has a page to show', () => {
    expect(totalPagesFor(0, 25)).toBe(1);
  });

  it('survives a zero page size', () => {
    expect(totalPagesFor(10, 0)).toBe(1);
  });
});

describe('buildAuditLogWhere', () => {
  it('is empty with no filters', () => {
    expect(buildAuditLogWhere()).toEqual({});
    expect(buildAuditLogWhere({})).toEqual({});
  });

  it('applies action and userId directly', () => {
    expect(buildAuditLogWhere({ action: 'SCAN_TRIGGERED', userId: 'u1' })).toEqual({
      action: 'SCAN_TRIGGERED',
      userId: 'u1',
    });
  });

  it('builds a case-insensitive OR for a search', () => {
    const where = buildAuditLogWhere({ search: 'repo' }) as { OR: unknown[] };
    expect(where.OR).toHaveLength(3);
    expect(where.OR[0]).toEqual({ action: { contains: 'repo', mode: 'insensitive' } });
  });

  it('drops a blank search instead of matching every row', () => {
    // An empty `contains` makes Postgres scan for a substring present in every
    // row — a full-table scan dressed up as a filter.
    expect(buildAuditLogWhere({ search: '' })).toEqual({});
    expect(buildAuditLogWhere({ search: '   ' })).toEqual({});
  });

  it('trims the search term', () => {
    const where = buildAuditLogWhere({ search: '  repo  ' }) as { OR: Array<Record<string, any>> };
    expect(where.OR[0].action.contains).toBe('repo');
  });

  it('applies an inclusive timestamp range when both bounds are given', () => {
    const startDate = new Date('2026-01-01T00:00:00.000Z');
    const endDate = new Date('2026-01-31T23:59:59.999Z');

    expect(buildAuditLogWhere({ startDate, endDate })).toEqual({
      timestamp: { gte: startDate, lte: endDate },
    });
  });

  it('supports an open-ended range with only a start or only an end date', () => {
    const startDate = new Date('2026-01-01T00:00:00.000Z');
    const endDate = new Date('2026-01-31T23:59:59.999Z');

    expect(buildAuditLogWhere({ startDate })).toEqual({ timestamp: { gte: startDate } });
    expect(buildAuditLogWhere({ endDate })).toEqual({ timestamp: { lte: endDate } });
  });

  it('combines the date range with the other filters', () => {
    const startDate = new Date('2026-01-01T00:00:00.000Z');

    expect(buildAuditLogWhere({ action: 'SCAN_TRIGGERED', startDate })).toEqual({
      action: 'SCAN_TRIGGERED',
      timestamp: { gte: startDate },
    });
  });
});

describe('buildUserWhere', () => {
  it('is empty with no filters', () => {
    expect(buildUserWhere()).toEqual({});
  });

  it('searches name, email and codename', () => {
    const where = buildUserWhere({ search: 'tokyo' }) as { OR: unknown[] };
    expect(where.OR).toHaveLength(3);
  });

  it('drops a blank search', () => {
    expect(buildUserWhere({ search: '  ' })).toEqual({});
  });

  it('filters by role, but not for ALL', () => {
    expect(buildUserWhere({ role: 'ADMIN' })).toEqual({
      roles: { some: { role: { name: 'ADMIN' } } },
    });
    expect(buildUserWhere({ role: 'ALL' })).toEqual({});
  });
});

describe('collectActorIds', () => {
  it('returns the distinct ids on the page', () => {
    expect(
      collectActorIds([{ userId: 'a' }, { userId: 'b' }, { userId: 'a' }])
    ).toEqual(['a', 'b']);
  });

  it('skips rows with no actor', () => {
    expect(collectActorIds([{ userId: null }, { userId: undefined }, { userId: 'a' }])).toEqual([
      'a',
    ]);
  });

  it('returns nothing for a page with no attributable rows', () => {
    // An empty result is the signal to skip the actor query entirely.
    expect(collectActorIds([{ userId: null }])).toEqual([]);
    expect(collectActorIds([])).toEqual([]);
  });

  it('is bounded by the page, not by the user table', () => {
    // The bug: the actor lookup used to be an unfiltered findMany over every
    // user in the system to resolve at most `pageSize` of them.
    const page = Array.from({ length: 25 }, (_, i) => ({ userId: `user-${i % 4}` }));
    expect(collectActorIds(page)).toHaveLength(4);
  });
});

describe('actionsFromGroups', () => {
  it('extracts and sorts the action names', () => {
    expect(
      actionsFromGroups([{ action: 'SCAN_TRIGGERED' }, { action: 'ADMIN_ROLE_UPDATE' }])
    ).toEqual(['ADMIN_ROLE_UPDATE', 'SCAN_TRIGGERED']);
  });

  it('drops null, undefined and empty actions', () => {
    expect(
      actionsFromGroups([{ action: null }, { action: undefined }, { action: '' }, { action: 'A' }])
    ).toEqual(['A']);
  });

  it('deduplicates, so a grouping that returns repeats is still safe', () => {
    expect(actionsFromGroups([{ action: 'A' }, { action: 'A' }])).toEqual(['A']);
  });

  it('handles an empty grouping', () => {
    expect(actionsFromGroups([])).toEqual([]);
  });
});

describe('limits', () => {
  it('keeps the fetch-all ceiling well above the page ceiling', () => {
    expect(USERS_FETCH_ALL_LIMIT).toBeGreaterThan(MAX_PAGE_SIZE);
  });
});