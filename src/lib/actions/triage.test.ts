import { describe, it, expect, vi, beforeEach } from 'vitest';
import { setFindingStatus } from '@/lib/actions/triage';
import { auth } from '@/auth';
import prisma from '@/lib/prisma';

vi.mock('@/auth', () => ({
  auth: vi.fn(),
}));

vi.mock('@/lib/prisma', () => ({
  default: {
    repository: { findFirst: vi.fn() },
    findingTriage: { upsert: vi.fn() },
    auditLog: { create: vi.fn() },
  },
}));

vi.mock('next/cache', () => ({
  revalidatePath: vi.fn(),
}));

const validInput = {
  repositoryId: 'repo-1',
  fingerprint: 'a'.repeat(64),
  status: 'FALSE_POSITIVE' as const,
  note: '  legit env var  ',
};

describe('setFindingStatus', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('rejects unauthenticated callers without touching the DB', async () => {
    (auth as any).mockResolvedValue(null);

    const result = await setFindingStatus(validInput);

    expect(result.ok).toBe(false);
    expect(prisma.repository.findFirst).not.toHaveBeenCalled();
    expect(prisma.findingTriage.upsert).not.toHaveBeenCalled();
  });

  it('rejects an invalid status', async () => {
    (auth as any).mockResolvedValue({ user: { id: 'user-1' } });

    const result = await setFindingStatus({ ...validInput, status: 'BOGUS' as any });

    expect(result.ok).toBe(false);
    expect(prisma.repository.findFirst).not.toHaveBeenCalled();
  });

  it('refuses to triage a repository the user does not own', async () => {
    (auth as any).mockResolvedValue({ user: { id: 'user-1' } });
    (prisma.repository.findFirst as any).mockResolvedValue(null);

    const result = await setFindingStatus(validInput);

    expect(result.ok).toBe(false);
    expect(result.error).toBe('Repository not found');
    expect(prisma.findingTriage.upsert).not.toHaveBeenCalled();
    expect(prisma.auditLog.create).not.toHaveBeenCalled();
  });

  it('upserts the triage row and writes one audit log entry on success', async () => {
    (auth as any).mockResolvedValue({ user: { id: 'user-1' } });
    (prisma.repository.findFirst as any).mockResolvedValue({ id: 'repo-1', fullName: 'acme/app' });
    (prisma.findingTriage.upsert as any).mockResolvedValue({});
    (prisma.auditLog.create as any).mockResolvedValue({});

    const result = await setFindingStatus(validInput);

    expect(result.ok).toBe(true);

    // Keyed off the stable fingerprint via the composite unique constraint,
    // and the note is trimmed.
    expect(prisma.findingTriage.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { repositoryId_fingerprint: { repositoryId: 'repo-1', fingerprint: validInput.fingerprint } },
        update: { status: 'FALSE_POSITIVE', note: 'legit env var', resolvedById: 'user-1' },
        create: expect.objectContaining({ status: 'FALSE_POSITIVE', note: 'legit env var', resolvedById: 'user-1' }),
      })
    );

    expect(prisma.auditLog.create).toHaveBeenCalledTimes(1);
    expect(prisma.auditLog.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ userId: 'user-1', action: 'Finding Triage', decision: 'FALSE_POSITIVE' }),
      })
    );
  });

  it('normalises a blank note to null', async () => {
    (auth as any).mockResolvedValue({ user: { id: 'user-1' } });
    (prisma.repository.findFirst as any).mockResolvedValue({ id: 'repo-1', fullName: 'acme/app' });
    (prisma.findingTriage.upsert as any).mockResolvedValue({});
    (prisma.auditLog.create as any).mockResolvedValue({});

    await setFindingStatus({ ...validInput, status: 'OPEN', note: '   ' });

    expect(prisma.findingTriage.upsert).toHaveBeenCalledWith(
      expect.objectContaining({ update: expect.objectContaining({ note: null }) })
    );
  });
});
