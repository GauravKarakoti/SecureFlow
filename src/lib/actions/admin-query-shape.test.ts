/**
 * The queries the admin actions actually issue (#645).
 *
 * `admin-remaining.test.ts` asserts the shape of what comes *back*. This file
 * asserts the shape of what goes *in*, because that is where the bug lived: the
 * results were correct, they were just paid for with two unbounded full-table
 * reads on every render.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

let mockSession: { user: { id: string; roles: string[] } } | null = {
  user: { id: 'admin-1', roles: ['ADMIN'] },
};

let mockAuditLogs: Array<Record<string, unknown>> = [];
let mockUsers: Array<Record<string, unknown>> = [];
let mockUserTotal = 0;
let mockGroups: Array<{ action: string }> = [];

// Typed to accept the Prisma args object: these tests assert on
// `.mock.calls[0][0]`, which a zero-arg signature would make untypeable.
type PrismaArgs = Record<string, unknown> | undefined;

const userFindMany = vi.fn(async (_args?: PrismaArgs) => mockUsers);
const auditFindMany = vi.fn(async (_args?: PrismaArgs) => mockAuditLogs);
const auditGroupBy = vi.fn(async (_args?: PrismaArgs) => mockGroups);
const userCount = vi.fn(async (_args?: PrismaArgs) => mockUserTotal);

vi.mock('@/auth', () => ({ auth: vi.fn(async () => mockSession) }));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));

vi.mock('@/lib/prisma', () => ({
  default: {
    user: { findMany: userFindMany, count: userCount },
    auditLog: {
      findMany: auditFindMany,
      count: vi.fn(async (_args?: PrismaArgs) => mockAuditLogs.length),
      groupBy: auditGroupBy,
    },
  },
}));

const { getAuditLogs, getAuditLogFilters, getAllUsers } = await import('./admin');
const { __setClockForTests } = await import('@/lib/admin/audit-filter-cache');

beforeEach(() => {
  vi.clearAllMocks();
  mockSession = { user: { id: 'admin-1', roles: ['ADMIN'] } };
  mockAuditLogs = [];
  mockUsers = [];
  mockUserTotal = 0;
  mockGroups = [];
  // Clears whatever a previous test left in the filter cache.
  __setClockForTests();
});

describe('getAuditLogs — actor lookup', () => {
  beforeEach(() => {
    mockAuditLogs = [
      { id: 'l1', userId: 'u1', action: 'A', resource: 'r', timestamp: new Date() },
      { id: 'l2', userId: 'u2', action: 'B', resource: 'r', timestamp: new Date() },
      { id: 'l3', userId: 'u1', action: 'C', resource: 'r', timestamp: new Date() },
    ];
    mockUsers = [
      { id: 'u1', name: 'Alice', email: 'a@x', codename: 'Tokyo' },
      { id: 'u2', name: 'Bob', email: 'b@x', codename: 'Berlin' },
    ];
  });

  it('scopes the actor query to the ids on the page', async () => {
    // This is the regression guard. It used to be
    // `prisma.user.findMany({ select: {...} })` — no where, no take, every row
    // in the table, on every render.
    await getAuditLogs({ page: 1, pageSize: 25 });

    expect(userFindMany).toHaveBeenCalledTimes(1);
    const args = userFindMany.mock.calls[0][0] as any;

    expect(args.where).toEqual({ id: { in: ['u1', 'u2'] } });
    expect(args.select).toEqual({ id: true, name: true, email: true, codename: true });
  });

  it('does not query users at all when no row has an actor', async () => {
    mockAuditLogs = [{ id: 'l1', userId: null, action: 'A', resource: 'r', timestamp: new Date() }];

    const result = await getAuditLogs();

    expect(userFindMany).not.toHaveBeenCalled();
    expect(result.logs[0].actor).toBeNull();
  });

  it('still attaches the right actor to each row', async () => {
    const result = await getAuditLogs();

    expect(result.logs[0].actor?.name).toBe('Alice');
    expect(result.logs[1].actor?.name).toBe('Bob');
    expect(result.logs[2].actor?.name).toBe('Alice');
  });

  it('leaves the actor null when the user row is gone', async () => {
    // AuditLog.userId is onDelete: SetNull, but a row can still be read between
    // the log query and the actor query.
    mockUsers = [{ id: 'u1', name: 'Alice', email: 'a@x', codename: 'Tokyo' }];

    const result = await getAuditLogs();

    expect(result.logs[1].actor).toBeNull();
  });

  it('bounds the log query with skip and take', async () => {
    await getAuditLogs({ page: 3, pageSize: 25 });

    const args = auditFindMany.mock.calls[0][0] as any;
    expect(args.skip).toBe(50);
    expect(args.take).toBe(25);
    expect(args.orderBy).toEqual({ timestamp: 'desc' });
  });

  it('clamps an oversized page size', async () => {
    await getAuditLogs({ pageSize: 10_000 });

    expect((auditFindMany.mock.calls[0][0] as any).take).toBe(200);
  });
});

describe('getAuditLogFilters', () => {
  beforeEach(() => {
    mockGroups = [{ action: 'SCAN_TRIGGERED' }, { action: 'ADMIN_ROLE_UPDATE' }];
  });

  it('uses groupBy rather than a distinct findMany', async () => {
    // Prisma applies `distinct` in the query engine after the rows come back,
    // so the old query read every AuditLog row's action column into memory.
    const result = await getAuditLogFilters();

    expect(auditGroupBy).toHaveBeenCalledWith({ by: ['action'], orderBy: { action: 'asc' } });
    expect(auditFindMany).not.toHaveBeenCalled();
    expect(result.actions).toEqual(['ADMIN_ROLE_UPDATE', 'SCAN_TRIGGERED']);
  });

  it('serves a second call from the cache', async () => {
    await getAuditLogFilters();
    await getAuditLogFilters();

    expect(auditGroupBy).toHaveBeenCalledTimes(1);
  });

  it('still checks authorisation on a cached call', async () => {
    // The cache must not become a way around requireAdmin.
    await getAuditLogFilters();

    mockSession = { user: { id: 'u1', roles: ['USER'] } };
    await expect(getAuditLogFilters()).rejects.toThrow('Unauthorized');
  });
});

describe('getAllUsers', () => {
  it('reports the total and does not claim truncation when it fits', async () => {
    mockUsers = [{ id: 'u1', roles: [], _count: { repositories: 0 }, createdAt: new Date() }];
    mockUserTotal = 1;

    const result = await getAllUsers();

    expect(result.users).toHaveLength(1);
    expect(result.total).toBe(1);
    expect(result.truncated).toBe(false);
  });

  it('pages through rather than silently returning the first page', async () => {
    // The old implementation asked for pageSize 10_000 against a clamp of 200
    // and returned 200 rows while presenting itself as "all users".
    const fullPage = Array.from({ length: 200 }, (_, i) => ({
      id: `u${i}`,
      roles: [],
      _count: { repositories: 0 },
      createdAt: new Date(),
    }));

    mockUserTotal = 350;
    userFindMany
      .mockImplementationOnce(async () => fullPage)
      .mockImplementationOnce(async () => fullPage.slice(0, 150));

    const result = await getAllUsers();

    expect(userFindMany).toHaveBeenCalledTimes(2);
    expect(result.users).toHaveLength(350);
    expect(result.truncated).toBe(false);
  });

  it('flags truncation when the total exceeds what it could fetch', async () => {
    mockUsers = [{ id: 'u1', roles: [], _count: { repositories: 0 }, createdAt: new Date() }];
    mockUserTotal = 9_000;

    const result = await getAllUsers();

    expect(result.truncated).toBe(true);
    expect(result.total).toBe(9_000);
  });

  it('requires an admin', async () => {
    mockSession = { user: { id: 'u1', roles: ['USER'] } };
    await expect(getAllUsers()).rejects.toThrow('Unauthorized');
  });
});
