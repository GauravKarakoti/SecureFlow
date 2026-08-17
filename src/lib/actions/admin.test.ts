import { describe, it, expect, vi, beforeEach } from 'vitest';
import { getAdminMetrics } from '@/lib/actions/admin';
import { auth } from '@/auth';
import prisma from '@/lib/prisma';

// Mock the dependencies
vi.mock('@/auth', () => ({
  auth: vi.fn(),
}));

vi.mock('@/lib/prisma', () => ({
  default: {
    user: { count: vi.fn() },
    pullRequest: { count: vi.fn() },
    auditLog: { count: vi.fn() },
  },
}));

describe('Admin Server Actions - getAdminMetrics', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should successfully return aggregated metrics for an ADMIN user', async () => {
    // Arrange: Mock session with ADMIN role
    (auth as any).mockResolvedValue({
      user: {
        id: 'admin-1',
        codename: 'Tokyo',
        roles: ['ADMIN'],
      },
    });

    // Arrange: Mock Prisma counts
    (prisma.user.count as any).mockResolvedValue(150);
    (prisma.pullRequest.count as any).mockResolvedValue(450);
    (prisma.auditLog.count as any).mockResolvedValue(1250);

    // Act
    const metrics = await getAdminMetrics();

    // Assert
    expect(auth).toHaveBeenCalledTimes(1);
    expect(prisma.user.count).toHaveBeenCalledTimes(1);
    expect(prisma.pullRequest.count).toHaveBeenCalledTimes(1);
    expect(prisma.auditLog.count).toHaveBeenCalledTimes(1);
    
    expect(metrics).toEqual({
      totalUsers: 150,
      totalPrs: 450,
      totalAudits: 1250,
    });
  });

  it('should throw Unauthorized error if user lacks ADMIN role (e.g. USER)', async () => {
    // Arrange: Mock session with only USER role
    (auth as any).mockResolvedValue({
      user: {
        id: 'user-1',
        codename: 'Berlin',
        roles: ['USER'],
      },
    });

    // Act & Assert
    await expect(getAdminMetrics()).rejects.toThrow('Unauthorized');
    
    // Ensure Prisma is never called if unauthorized
    expect(prisma.user.count).not.toHaveBeenCalled();
    expect(prisma.pullRequest.count).not.toHaveBeenCalled();
    expect(prisma.auditLog.count).not.toHaveBeenCalled();
  });

  it('should throw Unauthorized error if roles array is undefined', async () => {
    // Arrange: Mock session with undefined roles
    (auth as any).mockResolvedValue({
      user: {
        id: 'user-1',
        codename: 'Berlin',
      },
    });

    // Act & Assert
    await expect(getAdminMetrics()).rejects.toThrow('Unauthorized');
  });

  it('should throw Unauthorized error if session is entirely null', async () => {
    // Arrange: Mock null session (not logged in)
    (auth as any).mockResolvedValue(null);

    // Act & Assert
    await expect(getAdminMetrics()).rejects.toThrow('Unauthorized');
  });
});
