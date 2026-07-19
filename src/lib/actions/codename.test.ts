import { describe, it, expect, vi, beforeEach } from 'vitest';
import { updateCodename } from '@/lib/actions/codename';
import { auth } from '@/auth';
import prisma from '@/lib/prisma';

// Mock auth
vi.mock('@/auth', () => ({
  auth: vi.fn(),
}));

// Mock Prisma
vi.mock('@/lib/prisma', () => ({
  default: {
    user: {
      findFirst: vi.fn(),
      update: vi.fn(),
    },
    auditLog: {
      create: vi.fn(),
    },
  },
}));

describe('updateCodename server action', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.NEXT_PUBLIC_MOCK_AUTH = "false";
    process.env.NEXT_PUBLIC_MOCK_DB = "false";
  });

  it('should return error if not authenticated', async () => {
    (auth as any).mockResolvedValue(null);

    const res = await updateCodename('Tokyo');

    expect(res).toEqual({ ok: false, error: 'Not authenticated' });
    expect(prisma.user.update).not.toHaveBeenCalled();
  });

  it('should return error if codename is empty', async () => {
    (auth as any).mockResolvedValue({ user: { id: 'user-123' } });

    const res = await updateCodename('   ');

    expect(res).toEqual({ ok: false, error: 'Codename cannot be empty' });
    expect(prisma.user.update).not.toHaveBeenCalled();
  });

  it('should return error if codename contains invalid characters', async () => {
    (auth as any).mockResolvedValue({ user: { id: 'user-123' } });

    const res1 = await updateCodename('Tokyo!');
    const res2 = await updateCodename('Rio_123');

    expect(res1.ok).toBe(false);
    expect(res1.error).toContain('only letters, numbers, spaces, and hyphens');
    expect(res2.ok).toBe(false);
    expect(prisma.user.update).not.toHaveBeenCalled();
  });

  it('should return error if codename is too short or too long', async () => {
    (auth as any).mockResolvedValue({ user: { id: 'user-123' } });

    const resShort = await updateCodename('A');
    const resLong = await updateCodename('VeryLongCityNameThatIsMoreThanTwentyCharacters');

    expect(resShort.ok).toBe(false);
    expect(resShort.error).toContain('between 2 and 20 characters');
    expect(resLong.ok).toBe(false);
    expect(prisma.user.update).not.toHaveBeenCalled();
  });

  it('should return error if codename is already taken by another user', async () => {
    (auth as any).mockResolvedValue({ user: { id: 'user-123' } });
    (prisma.user.findFirst as any).mockResolvedValue({ id: 'user-456', codename: 'Berlin' });

    const res = await updateCodename('Berlin');

    expect(res).toEqual({ ok: false, error: 'This codename is already taken by another crew member' });
    expect(prisma.user.update).not.toHaveBeenCalled();
  });

  it('should allow setting same codename for current user', async () => {
    (auth as any).mockResolvedValue({ user: { id: 'user-123' } });
    (prisma.user.findFirst as any).mockResolvedValue({ id: 'user-123', codename: 'Berlin' });

    const res = await updateCodename('Berlin');

    expect(res.ok).toBe(true);
    expect(prisma.user.update).toHaveBeenCalledWith({
      where: { id: 'user-123' },
      data: { codename: 'Berlin' },
    });
  });

  it('should successfully update codename and log audit entry on success', async () => {
    (auth as any).mockResolvedValue({ user: { id: 'user-123' } });
    (prisma.user.findFirst as any).mockResolvedValue(null);

    const res = await updateCodename('Berlin');

    expect(res).toEqual({ ok: true });
    expect(prisma.user.update).toHaveBeenCalledWith({
      where: { id: 'user-123' },
      data: { codename: 'Berlin' },
    });
    expect(prisma.auditLog.create).toHaveBeenCalledWith({
      data: {
        userId: 'user-123',
        action: 'UPDATE_CODENAME',
        resource: 'user:user-123',
        decision: 'Berlin',
        metadata: { codename: 'Berlin' },
      },
    });
  });
});
