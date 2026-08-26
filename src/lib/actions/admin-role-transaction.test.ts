import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * The last-administrator invariant under concurrency (#658).
 *
 * The pre-existing tests in `admin-remaining.test.ts` cover the sequential
 * cases. What they cannot show is the interleaving that motivated the change:
 * the guard used to be a `count()` outside the transaction that then performed
 * the write, so two demotions issued close together both read the pre-race
 * count, both passed, and the application was left with zero administrators
 * and no in-app way back.
 *
 * The fake database below applies writes immediately and rolls them back when
 * the transaction callback throws, which is the only behaviour the fix relies
 * on. The stale pre-check both requests see is modelled explicitly rather than
 * left to real concurrency, so the test is deterministic.
 */

const ADMIN_ROLE_ID = 'role-admin';
const USER_ROLE_ID = 'role-user';

interface FakeState {
  /** Ids of users currently holding the ADMIN role. */
  admins: Set<string>;
  /** Every user id that exists. */
  users: Set<string>;
  /** AuditLog rows written. */
  audits: Array<Record<string, unknown>>;
}

let state: FakeState;
let session: { user: { id: string; roles: string[] } } | null;
let targets: Record<string, Record<string, unknown>>;

/**
 * Values `user.count` should return for the first calls, in order.
 *
 * Used to hand both racing requests the same pre-race count. Once the queue is
 * drained, `count` reports live state — which is what the in-transaction
 * assertion needs to see.
 */
let stagedCounts: number[];

vi.mock('@/auth', () => ({
  auth: vi.fn(async () => session),
}));

vi.mock('next/cache', () => ({
  revalidatePath: vi.fn(),
}));

vi.mock('@/lib/admin/audit-filter-cache', () => ({
  invalidateCachedActions: vi.fn(),
  readCachedActions: vi.fn(() => null),
  writeCachedActions: vi.fn(),
}));

vi.mock('@/lib/prisma', () => {
  const db: any = {
    $transaction: vi.fn(async (arg: any) => {
      if (typeof arg !== 'function') {
        const results = [];
        for (const q of arg) results.push(typeof q === 'function' ? await q() : await q);
        return results;
      }

      // Snapshot for rollback. A throw out of the callback must undo the
      // writes it already made — that is the entire mechanism the fix uses.
      const snapshot: FakeState = {
        admins: new Set(state.admins),
        users: new Set(state.users),
        audits: [...state.audits],
      };

      try {
        return await arg(db);
      } catch (err) {
        state = snapshot;
        throw err;
      }
    }),

    user: {
      findUnique: vi.fn(async ({ where: { id } }: any) => targets[id] ?? null),

      count: vi.fn(async () => {
        if (stagedCounts.length > 0) return stagedCounts.shift() as number;
        return state.admins.size;
      }),

      delete: vi.fn(async ({ where: { id } }: any) => {
        state.users.delete(id);
        state.admins.delete(id);
        return { id };
      }),
    },

    role: {
      upsert: vi.fn(async ({ where: { name } }: any) => ({
        id: name === 'ADMIN' ? ADMIN_ROLE_ID : USER_ROLE_ID,
        name,
      })),
      findUnique: vi.fn(async ({ where: { name } }: any) => ({
        id: name === 'ADMIN' ? ADMIN_ROLE_ID : USER_ROLE_ID,
        name,
      })),
    },

    userRole: {
      deleteMany: vi.fn(async ({ where: { userId } }: any) => {
        state.admins.delete(userId);
        return { count: 1 };
      }),
      create: vi.fn(async ({ data: { userId, roleId } }: any) => {
        if (roleId === ADMIN_ROLE_ID) state.admins.add(userId);
        return { userId, roleId };
      }),
    },

    auditLog: {
      create: vi.fn(async ({ data }: any) => {
        state.audits.push(data);
        return data;
      }),
    },
  };

  return { default: db };
});

import { updateUserRole, deleteUser } from './admin';
import prisma from '@/lib/prisma';

function adminTarget(id: string) {
  return {
    id,
    name: id,
    email: `${id}@example.com`,
    codename: id,
    roles: [{ role: { name: 'ADMIN' } }],
  };
}

function plainTarget(id: string) {
  return {
    id,
    name: id,
    email: `${id}@example.com`,
    codename: id,
    roles: [{ role: { name: 'USER' } }],
  };
}

describe('Last-administrator invariant under concurrency (#658)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    session = { user: { id: 'actor-admin', roles: ['ADMIN'] } };
    stagedCounts = [];
    state = {
      admins: new Set(['admin-a', 'admin-b', 'actor-admin']),
      users: new Set(['admin-a', 'admin-b', 'actor-admin', 'user-plain']),
      audits: [],
    };
    targets = {
      'admin-a': adminTarget('admin-a'),
      'admin-b': adminTarget('admin-b'),
      'user-plain': plainTarget('user-plain'),
    };
  });

  describe('updateUserRole', () => {
    it('refuses the second of two demotions that both passed the pre-check', async () => {
      // Exactly two administrators, and both requests read "2" before either
      // wrote — the interleaving the old guard could not see. Two operators, or
      // one operator double-clicking two rows on /admin/users.
      state.admins = new Set(['admin-a', 'admin-b']);
      stagedCounts = [2, 2];

      const first = await updateUserRole('admin-b', 'USER');
      expect(first.success).toBe(true);
      expect(state.admins.size).toBe(1);

      // Same stale pre-check, but the assertion inside the transaction now sees
      // the state this write actually produced.
      await expect(updateUserRole('admin-a', 'USER')).rejects.toThrow(
        'Cannot demote the last remaining administrator.'
      );

      expect(state.admins.size).toBe(1);
      expect([...state.admins]).toEqual(['admin-a']);
    });

    it('rolls the write back rather than leaving a half-applied demotion', async () => {
      state.admins = new Set(['admin-a']);
      stagedCounts = [2]; // a stale pre-check that should not have let this through

      await expect(updateUserRole('admin-a', 'USER')).rejects.toThrow(
        'Cannot demote the last remaining administrator.'
      );

      // deleteMany ran inside the transaction and was undone by the rollback.
      expect(prisma.userRole.deleteMany).toHaveBeenCalled();
      expect(state.admins.has('admin-a')).toBe(true);
    });

    it('writes no audit entry for a demotion that was rolled back', async () => {
      state.admins = new Set(['admin-a']);
      stagedCounts = [2];

      await expect(updateUserRole('admin-a', 'USER')).rejects.toThrow();

      expect(state.audits).toHaveLength(0);
    });

    it('still fails fast on the pre-check when there is no race', async () => {
      state.admins = new Set(['admin-a']);

      await expect(updateUserRole('admin-a', 'USER')).rejects.toThrow(
        'Cannot demote the last remaining administrator.'
      );

      // Rejected before opening a transaction at all.
      expect(prisma.$transaction).not.toHaveBeenCalled();
    });

    it('records the role change in the same transaction as the write', async () => {
      const result = await updateUserRole('user-plain', 'ADMIN');

      expect(result.success).toBe(true);
      expect(state.admins.has('user-plain')).toBe(true);
      expect(state.audits).toHaveLength(1);
      expect(state.audits[0]).toMatchObject({
        action: 'ADMIN_ROLE_UPDATE',
        resource: 'user:user-plain',
        decision: 'ADMIN',
      });
    });

    it('undoes the role change when the audit write fails', async () => {
      (prisma.auditLog.create as any).mockRejectedValueOnce(new Error('audit down'));

      await expect(updateUserRole('user-plain', 'ADMIN')).rejects.toThrow('audit down');

      // Previously the audit write was a separate statement afterwards, so this
      // left a role change nobody could attribute.
      expect(state.admins.has('user-plain')).toBe(false);
    });

    it('recovers from a P2002 on the role upsert instead of surfacing it', async () => {
      (prisma.role.upsert as any).mockRejectedValueOnce({ code: 'P2002' });

      const result = await updateUserRole('user-plain', 'ADMIN');

      expect(result.success).toBe(true);
      expect(prisma.role.findUnique).toHaveBeenCalledWith({ where: { name: 'ADMIN' } });
    });

    it('still surfaces an unrelated database error', async () => {
      (prisma.role.upsert as any).mockRejectedValueOnce(new Error('connection reset'));

      await expect(updateUserRole('user-plain', 'ADMIN')).rejects.toThrow('connection reset');
    });

    it('does not open a transaction for a no-op change', async () => {
      const result = await updateUserRole('user-plain', 'USER');

      expect(result).toMatchObject({ success: true, unchanged: true });
      expect(prisma.$transaction).not.toHaveBeenCalled();
    });
  });

  describe('deleteUser', () => {
    it('refuses the second of two deletions that both passed the pre-check', async () => {
      state.admins = new Set(['admin-a', 'admin-b']);
      stagedCounts = [2, 2];

      await deleteUser('admin-b');
      expect(state.admins.size).toBe(1);

      await expect(deleteUser('admin-a')).rejects.toThrow(
        'Cannot delete the last remaining administrator.'
      );

      expect(state.admins.has('admin-a')).toBe(true);
      expect(state.users.has('admin-a')).toBe(true);
    });

    it('rolls the delete back rather than losing the user', async () => {
      state.admins = new Set(['admin-a']);
      stagedCounts = [2];

      await expect(deleteUser('admin-a')).rejects.toThrow(
        'Cannot delete the last remaining administrator.'
      );

      expect(prisma.user.delete).toHaveBeenCalled();
      expect(state.users.has('admin-a')).toBe(true);
    });

    it('records the deletion in the same transaction, with the roles the user held', async () => {
      const result = await deleteUser('user-plain');

      expect(result.success).toBe(true);
      expect(state.users.has('user-plain')).toBe(false);
      expect(state.audits[0]).toMatchObject({
        action: 'ADMIN_USER_DELETE',
        resource: 'user:user-plain',
        decision: 'DELETED',
        metadata: expect.objectContaining({ targetRoles: ['USER'] }),
      });
    });

    it('undoes the delete when the audit write fails', async () => {
      (prisma.auditLog.create as any).mockRejectedValueOnce(new Error('audit down'));

      await expect(deleteUser('user-plain')).rejects.toThrow('audit down');

      // The user's email and codename only existed on the row being removed and
      // in this audit entry, so losing the entry after the delete lost both.
      expect(state.users.has('user-plain')).toBe(true);
    });

    it('still refuses self-deletion before touching the database', async () => {
      await expect(deleteUser('actor-admin')).rejects.toThrow(
        'You cannot delete your own account.'
      );
      expect(prisma.$transaction).not.toHaveBeenCalled();
    });
  });
});
