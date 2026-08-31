import { describe, it, expect, vi, beforeEach } from 'vitest';
import { setFindingStatus, setFindingStatusBulk } from '@/lib/actions/triage';
import { auth } from '@/auth';
import prisma from '@/lib/prisma';

vi.mock('@/auth', () => ({
  auth: vi.fn(),
}));

vi.mock('@/lib/prisma', () => ({
  default: {
    repository: { findFirst: vi.fn(), findMany: vi.fn() },
    findingTriage: { upsert: vi.fn() },
    auditLog: { create: vi.fn() },
    $transaction: vi.fn(),
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
        data: expect.objectContaining({ userId: 'user-1', action: 'FINDING TRIAGE', decision: 'FALSE_POSITIVE' }),
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

describe('setFindingStatusBulk', () => {
  const targets = [
    { repositoryId: 'repo-1', fingerprint: 'a'.repeat(64) },
    { repositoryId: 'repo-1', fingerprint: 'b'.repeat(64) },
  ];

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('rejects unauthenticated callers without touching the DB', async () => {
    (auth as any).mockResolvedValue(null);

    const result = await setFindingStatusBulk({ targets, status: 'RESOLVED' });

    expect(result.ok).toBe(false);
    expect(prisma.repository.findMany).not.toHaveBeenCalled();
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('rejects an invalid status', async () => {
    (auth as any).mockResolvedValue({ user: { id: 'user-1' } });

    const result = await setFindingStatusBulk({ targets, status: 'BOGUS' as any });

    expect(result.ok).toBe(false);
    expect(prisma.repository.findMany).not.toHaveBeenCalled();
  });

  it('rejects an empty selection', async () => {
    (auth as any).mockResolvedValue({ user: { id: 'user-1' } });

    const result = await setFindingStatusBulk({ targets: [], status: 'RESOLVED' });

    expect(result.ok).toBe(false);
    expect(result.updated).toBe(0);
    expect(prisma.repository.findMany).not.toHaveBeenCalled();
  });

  it('refuses when a selected repository is not owned by the user', async () => {
    (auth as any).mockResolvedValue({ user: { id: 'user-1' } });
    // Only one repo comes back for the single distinct repo requested? Simulate none owned.
    (prisma.repository.findMany as any).mockResolvedValue([]);

    const result = await setFindingStatusBulk({ targets, status: 'RESOLVED' });

    expect(result.ok).toBe(false);
    expect(result.error).toBe('Repository not found');
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('upserts every target and writes one audit entry per finding', async () => {
    (auth as any).mockResolvedValue({ user: { id: 'user-1' } });
    (prisma.repository.findMany as any).mockResolvedValue([
      { id: 'repo-1', fullName: 'acme/app' },
    ]);
    (prisma.findingTriage.upsert as any).mockReturnValue('upsert-op');
    (prisma.auditLog.create as any).mockReturnValue('audit-op');
    (prisma.$transaction as any).mockResolvedValue([]);

    const result = await setFindingStatusBulk({
      targets,
      status: 'IGNORED',
      note: '  bulk note  ',
    });

    expect(result.ok).toBe(true);
    expect(result.updated).toBe(2);

    // One upsert + one audit entry per target.
    expect(prisma.findingTriage.upsert).toHaveBeenCalledTimes(2);
    expect(prisma.auditLog.create).toHaveBeenCalledTimes(2);
    expect(prisma.$transaction).toHaveBeenCalledTimes(1);

    // Note is trimmed and applied to each upsert.
    expect(prisma.findingTriage.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        update: expect.objectContaining({ status: 'IGNORED', note: 'bulk note', resolvedById: 'user-1' }),
      })
    );
  });

  it('rejects a selection over the per-call cap', async () => {
    (auth as any).mockResolvedValue({ user: { id: 'user-1' } });

    const tooMany = Array.from({ length: 101 }, (_, i) => ({
      repositoryId: 'repo-1',
      fingerprint: String(i).padStart(64, '0'),
    }));

    const result = await setFindingStatusBulk({ targets: tooMany, status: 'RESOLVED' });

    expect(result.ok).toBe(false);
    expect(prisma.repository.findMany).not.toHaveBeenCalled();
  });
});
