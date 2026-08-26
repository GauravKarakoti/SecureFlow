import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * Server-action behaviour for /dashboard/audit (#659).
 *
 * The two things worth pinning: the filter dropdowns aggregate rather than
 * reading every row the user has ever produced, and the CSV export tells the
 * caller when it truncated.
 */

let session: { user: { id: string } } | null = { user: { id: 'user-1' } };

vi.mock('@/auth', () => ({
  auth: vi.fn(async () => session),
}));

const mockFindMany = vi.hoisted(() => vi.fn());
const mockCount = vi.hoisted(() => vi.fn());
const mockGroupBy = vi.hoisted(() => vi.fn());

vi.mock('@/lib/prisma', () => ({
  default: {
    auditLog: {
      findMany: mockFindMany,
      count: mockCount,
      groupBy: mockGroupBy,
    },
  },
}));

import {
  MAX_EXPORT_ROWS,
  getUserAuditLogFilters,
  getUserAuditLogs,
  getUserAuditLogsForExport,
} from './audit';
import { __setUserFilterClockForTests } from '@/lib/audit/user-filter-cache';

function logRow(i: number) {
  return {
    id: `log-${i}`,
    userId: 'user-1',
    action: 'SCAN',
    resource: 'acme/api',
    decision: 'PASS',
    metadata: null,
    timestamp: new Date('2026-01-01T00:00:00.000Z'),
  };
}

let now = 5_000_000;

beforeEach(() => {
  vi.clearAllMocks();
  session = { user: { id: 'user-1' } };
  now = 5_000_000;
  __setUserFilterClockForTests(() => now);

  mockFindMany.mockResolvedValue([]);
  mockCount.mockResolvedValue(0);
  mockGroupBy.mockResolvedValue([]);
});

describe('getUserAuditLogFilters (#659)', () => {
  it('aggregates instead of reading every row', async () => {
    mockGroupBy
      .mockResolvedValueOnce([{ action: 'SCAN' }, { action: 'TRIAGE' }])
      .mockResolvedValueOnce([{ decision: 'PASS' }, { decision: 'BLOCK' }]);

    const filters = await getUserAuditLogFilters();

    expect(filters).toEqual({ actions: ['SCAN', 'TRIAGE'], decisions: ['BLOCK', 'PASS'] });
    // The shape this replaced: findMany({ distinct }) with no take.
    expect(mockFindMany).not.toHaveBeenCalled();
  });

  it('scopes both aggregates to the caller', async () => {
    await getUserAuditLogFilters();

    expect(mockGroupBy).toHaveBeenNthCalledWith(1, {
      by: ['action'],
      where: { userId: 'user-1' },
      orderBy: { action: 'asc' },
    });
    expect(mockGroupBy).toHaveBeenNthCalledWith(2, {
      by: ['decision'],
      where: { userId: 'user-1', decision: { not: null } },
      orderBy: { decision: 'asc' },
    });
  });

  it('serves the second call from cache, so a filter change costs no query', async () => {
    mockGroupBy
      .mockResolvedValueOnce([{ action: 'SCAN' }])
      .mockResolvedValueOnce([{ decision: 'PASS' }]);

    const first = await getUserAuditLogFilters();
    mockGroupBy.mockClear();
    const second = await getUserAuditLogFilters();

    expect(second).toEqual(first);
    expect(mockGroupBy).not.toHaveBeenCalled();
  });

  it('does not serve one user the other user\'s filter list', async () => {
    mockGroupBy
      .mockResolvedValueOnce([{ action: 'ALICE_ONLY' }])
      .mockResolvedValueOnce([]);
    await getUserAuditLogFilters();

    session = { user: { id: 'user-2' } };
    mockGroupBy
      .mockResolvedValueOnce([{ action: 'BOB_ONLY' }])
      .mockResolvedValueOnce([]);

    expect((await getUserAuditLogFilters()).actions).toEqual(['BOB_ONLY']);
  });

  it('re-queries once the cached list has expired', async () => {
    mockGroupBy.mockResolvedValue([]);
    await getUserAuditLogFilters();

    now += 60_001;
    mockGroupBy.mockClear();
    await getUserAuditLogFilters();

    expect(mockGroupBy).toHaveBeenCalledTimes(2);
  });

  it('rejects an unauthenticated caller before querying', async () => {
    session = null;

    await expect(getUserAuditLogFilters()).rejects.toThrow('Unauthorized');
    expect(mockGroupBy).not.toHaveBeenCalled();
  });
});

describe('getUserAuditLogsForExport (#659)', () => {
  it('reports a complete export honestly', async () => {
    mockFindMany.mockResolvedValue([logRow(1), logRow(2)]);
    mockCount.mockResolvedValue(2);

    const result = await getUserAuditLogsForExport();

    expect(result).toMatchObject({ total: 2, truncated: false, limit: MAX_EXPORT_ROWS });
    expect(result.rows).toHaveLength(2);
  });

  it('flags a truncated export instead of returning a bare array', async () => {
    // The previous shape returned only the rows, so the caller could not tell
    // "here are all 4,000" from "here are the newest 5,000 of 40,000" — and
    // handed the user a CSV that looked complete.
    mockFindMany.mockResolvedValue(
      Array.from({ length: MAX_EXPORT_ROWS }, (_, i) => logRow(i))
    );
    mockCount.mockResolvedValue(40_000);

    const result = await getUserAuditLogsForExport();

    expect(result.truncated).toBe(true);
    expect(result.total).toBe(40_000);
    expect(result.rows).toHaveLength(MAX_EXPORT_ROWS);
  });

  it('is not truncated when the match lands exactly on the cap', async () => {
    mockFindMany.mockResolvedValue(
      Array.from({ length: MAX_EXPORT_ROWS }, (_, i) => logRow(i))
    );
    mockCount.mockResolvedValue(MAX_EXPORT_ROWS);

    expect((await getUserAuditLogsForExport()).truncated).toBe(false);
  });

  it('caps the read and counts against the same filters', async () => {
    await getUserAuditLogsForExport({ action: 'SCAN' });

    const findArgs = mockFindMany.mock.calls[0][0];
    const countArgs = mockCount.mock.calls[0][0];

    expect(findArgs.take).toBe(MAX_EXPORT_ROWS);
    expect(findArgs.where).toEqual(countArgs.where);
    expect(findArgs.where).toMatchObject({ userId: 'user-1', action: 'SCAN' });
  });

  it('handles an empty result without claiming truncation', async () => {
    const result = await getUserAuditLogsForExport();

    expect(result).toMatchObject({ total: 0, truncated: false });
    expect(result.rows).toEqual([]);
  });

  it('rejects an unauthenticated caller', async () => {
    session = null;

    await expect(getUserAuditLogsForExport()).rejects.toThrow('Unauthorized');
  });
});

describe('getUserAuditLogs (#659 regression guard)', () => {
  it('still pages and still scopes to the caller', async () => {
    mockFindMany.mockResolvedValue([logRow(1)]);
    mockCount.mockResolvedValue(31);

    const result = await getUserAuditLogs({ page: 2, pageSize: 10 });

    expect(result).toMatchObject({ total: 31, page: 2, pageSize: 10, totalPages: 4 });
    expect(mockFindMany.mock.calls[0][0]).toMatchObject({
      skip: 10,
      take: 10,
      where: { userId: 'user-1' },
    });
  });

  it('clamps an absurd page size rather than passing it through', async () => {
    await getUserAuditLogs({ pageSize: 100_000 });

    expect(mockFindMany.mock.calls[0][0].take).toBe(100);
  });
});
