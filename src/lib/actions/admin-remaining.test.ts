import { describe, it, expect, vi, beforeEach } from 'vitest';


// Shared mock state
let mockSession: { user: { id: string; roles: string[] } } | null = {
  user: { id: 'admin-1', roles: ['ADMIN'] },
};

let mockUsers: unknown[] = [];
let mockUserCounts: Record<string, number> = {};
let mockAuditLogs: unknown[] = [];
// Removed mockRole because it is never used.
let mockTargetUser: Record<string, unknown> | null = null;

vi.mock('@/auth', () => ({
  auth: vi.fn(async () => mockSession),
}));

vi.mock('next/cache', () => ({
  revalidatePath: vi.fn(),
}));

vi.mock('@/lib/prisma', () => ({
  default: {
    $transaction: vi.fn(async (queries: any[]) => {
      // Execute each query in the transaction and return results
      const results = [];
      for (const q of queries) {
        results.push(typeof q === 'function' ? await q() : await q);
      }
      return results;
    }),
    user: {
      findMany: vi.fn(async () => mockUsers),
      findUnique: vi.fn(async ({ where: { id } }: any) => {
        if (mockTargetUser && mockTargetUser.id === id) return mockTargetUser;
        return null;
      }),
      count: vi.fn(async ({ where }: any = {}) => {
        // If no where clause, return total count
        if (!where) return mockUserCounts['total'] ?? 0;
        // Prisma uses `some` as an object filter, not a function call
        if (where.roles?.some?.role?.name === 'ADMIN') return mockUserCounts['admins'] ?? 0;
        if (where.roles?.some?.role?.name === 'USER') return mockUserCounts['standard'] ?? 0;
        if (where.createdAt?.gte) return mockUserCounts['last24h'] ?? 0;
        return 0;
      }),
      delete: vi.fn(async () => ({})),
    },
    pullRequest: { count: vi.fn(async () => 0) },
    auditLog: {
      count: vi.fn(async () => 0),
      findMany: vi.fn(async () => mockAuditLogs),
      groupBy: vi.fn(async () => []),
      create: vi.fn(async (data: any) => data),
    },
    role: {
      upsert: vi.fn(async ({ create }: any) => ({ id: 'role-new', ...create })),
    },
    userRole: {
      deleteMany: vi.fn(async () => ({ count: 0 })),
      create: vi.fn(async (data: any) => data),
    },
  },
}));

import {
  getUsers,
  getUserManagementMetrics,
  updateUserRole,
  deleteUser,
  getAuditLogs,
  getAuditLogMetrics,
  getAuditLogFilters,
} from './admin';
import { revalidatePath } from 'next/cache';

describe('Admin Server Actions - getUsers', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSession = { user: { id: 'admin-1', roles: ['ADMIN'] } };
    mockUsers = [
      {
        id: 'user-1',
        name: 'Alice',
        email: 'alice@example.com',
        codename: 'Tokyo',
        image: null,
        roles: [{ role: { name: 'ADMIN' } }],
        _count: { repositories: 5 },
        createdAt: new Date('2024-01-01'),
      },
      {
        id: 'user-2',
        name: 'Bob',
        email: 'bob@example.com',
        codename: 'Berlin',
        image: null,
        roles: [{ role: { name: 'USER' } }],
        _count: { repositories: 2 },
        createdAt: new Date('2024-02-01'),
      },
    ];
  });

  it('returns mapped user rows for an admin', async () => {
    const users = await getUsers();
    expect(users).toHaveLength(2);
    expect(users[0]).toEqual({
      id: 'user-1',
      name: 'Alice',
      email: 'alice@example.com',
      codename: 'Tokyo',
      image: null,
      roles: ['ADMIN'],
      repoCount: 5,
      createdAt: expect.any(Date),
    });
    expect(users[1].roles).toEqual(['USER']);
    expect(users[1].repoCount).toBe(2);
  });

  it('throws Unauthorized for non-admin users', async () => {
    mockSession = { user: { id: 'user-1', roles: ['USER'] } };
    await expect(getUsers()).rejects.toThrow('Unauthorized');
  });

  it('throws Unauthorized when session is null', async () => {
    mockSession = null;
    await expect(getUsers()).rejects.toThrow('Unauthorized');
  });
});

describe('Admin Server Actions - getUserManagementMetrics', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSession = { user: { id: 'admin-1', roles: ['ADMIN'] } };
    mockUserCounts = { total: 100, admins: 5, standard: 95, last24h: 3 };
  });

  it('returns aggregated user metrics', async () => {
    const metrics = await getUserManagementMetrics();
    expect(metrics).toEqual({
      total: 100,
      admins: 5,
      standard: 95,
      last24h: 3,
    });
  });

  it('throws Unauthorized for non-admin users', async () => {
    mockSession = { user: { id: 'user-1', roles: ['USER'] } };
    await expect(getUserManagementMetrics()).rejects.toThrow('Unauthorized');
  });
});

describe('Admin Server Actions - updateUserRole', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSession = { user: { id: 'admin-1', roles: ['ADMIN'] } };
    mockTargetUser = {
      id: 'user-2',
      name: 'Bob',
      email: 'bob@example.com',
      codename: 'Berlin',
      roles: [{ role: { name: 'USER' } }],
    };
    mockUserCounts = { admins: 3 };
  });

  it('upgrades a USER to ADMIN', async () => {
    const result = await updateUserRole('user-2', 'ADMIN');
    expect(result.success).toBe(true);
  });

  it('prevents removing own ADMIN role', async () => {
    await expect(updateUserRole('admin-1', 'USER')).rejects.toThrow(
      'You cannot remove your own admin role.'
    );
  });

  it('prevents demoting the last ADMIN', async () => {
    mockUserCounts = { admins: 1 };
    mockTargetUser = {
      id: 'user-2',
      name: 'Bob',
      email: 'bob@example.com',
      codename: 'Berlin',
      roles: [{ role: { name: 'ADMIN' } }],
    };
    await expect(updateUserRole('user-2', 'USER')).rejects.toThrow(
      'Cannot demote the last remaining administrator.'
    );
  });

  it('returns unchanged when the user already has the target role', async () => {
    mockTargetUser = {
      id: 'user-2',
      name: 'Bob',
      email: 'bob@example.com',
      codename: 'Berlin',
      roles: [{ role: { name: 'USER' } }],
    };
    const result = await updateUserRole('user-2', 'USER');
    expect(result.unchanged).toBe(true);
  });

  it('throws when target user is not found', async () => {
    mockTargetUser = null;
    await expect(updateUserRole('nonexistent', 'ADMIN')).rejects.toThrow('User not found.');
  });

  it('throws Unauthorized for non-admin callers', async () => {
    mockSession = { user: { id: 'user-1', roles: ['USER'] } };
    await expect(updateUserRole('user-2', 'ADMIN')).rejects.toThrow('Unauthorized');
  });
});

describe('Admin Server Actions - deleteUser', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSession = { user: { id: 'admin-1', roles: ['ADMIN'] } };
    mockTargetUser = {
      id: 'user-2',
      name: 'Bob',
      email: 'bob@example.com',
      codename: 'Berlin',
      roles: [{ role: { name: 'USER' } }],
    };
    mockUserCounts = { admins: 3 };
  });

  it('deletes a non-admin user successfully', async () => {
    const result = await deleteUser('user-2');
    expect(result.success).toBe(true);
  });

  it('prevents deleting own account', async () => {
    await expect(deleteUser('admin-1')).rejects.toThrow('You cannot delete your own account.');
  });

  it('prevents deleting the last ADMIN', async () => {
    mockUserCounts = { admins: 1 };
    mockTargetUser = {
      id: 'user-2',
      name: 'Bob',
      email: 'bob@example.com',
      codename: 'Berlin',
      roles: [{ role: { name: 'ADMIN' } }],
    };
    await expect(deleteUser('user-2')).rejects.toThrow(
      'Cannot delete the last remaining administrator.'
    );
  });

  it('throws when target user is not found', async () => {
    mockTargetUser = null;
    await expect(deleteUser('nonexistent')).rejects.toThrow('User not found.');
  });

  it('throws Unauthorized for non-admin callers', async () => {
    mockSession = { user: { id: 'user-1', roles: ['USER'] } };
    await expect(deleteUser('user-2')).rejects.toThrow('Unauthorized');
  });
});

describe('Admin Server Actions - getAuditLogs', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSession = { user: { id: 'admin-1', roles: ['ADMIN'] } };
    mockAuditLogs = [
      {
        id: 'log-1',
        userId: 'user-1',
        action: 'SCAN_TRIGGERED',
        resource: 'org/repo#1',
        decision: null,
        metadata: {},
        timestamp: new Date('2024-01-01'),
      },
    ];
    mockUsers = [
      { id: 'user-1', name: 'Alice', email: 'alice@example.com', codename: 'Tokyo' },
    ];
  });

  it('returns paginated audit logs with actor info', async () => {
    const result = await getAuditLogs({ page: 1, pageSize: 25 });
    expect(result.logs).toHaveLength(1);
    expect(result.logs[0].actor).toBeDefined();
    expect(result.logs[0].actor?.name).toBe('Alice');
    expect(result.page).toBe(1);
    expect(result.pageSize).toBe(25);
  });

  it('throws Unauthorized for non-admin callers', async () => {
    mockSession = { user: { id: 'user-1', roles: ['USER'] } };
    await expect(getAuditLogs()).rejects.toThrow('Unauthorized');
  });
});

describe('Admin Server Actions - getAuditLogMetrics', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSession = { user: { id: 'admin-1', roles: ['ADMIN'] } };
  });

  it('returns audit log metrics', async () => {
    const metrics = await getAuditLogMetrics();
    expect(metrics).toHaveProperty('total');
    expect(metrics).toHaveProperty('last24h');
    expect(metrics).toHaveProperty('topActions');
  });

  it('throws Unauthorized for non-admin callers', async () => {
    mockSession = { user: { id: 'user-1', roles: ['USER'] } };
    await expect(getAuditLogMetrics()).rejects.toThrow('Unauthorized');
  });
});

describe('Admin Server Actions - getAuditLogFilters', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSession = { user: { id: 'admin-1', roles: ['ADMIN'] } };
    mockAuditLogs = [
      { action: 'SCAN_TRIGGERED' },
      { action: 'PR_COMMENT_POSTED' },
    ];
  });

  it('returns distinct action names', async () => {
    const result = await getAuditLogFilters();
    expect(result.actions).toBeDefined();
    expect(Array.isArray(result.actions)).toBe(true);
  });

  it('throws Unauthorized for non-admin callers', async () => {
    mockSession = { user: { id: 'user-1', roles: ['USER'] } };
    await expect(getAuditLogFilters()).rejects.toThrow('Unauthorized');
  });
});